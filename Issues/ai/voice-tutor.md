# Voice Tutor — Talking Avatar AI Tutor

- **Type:** AFK
- **Phase:** 2 (post F06)
- **Depends on:** AI04 Tutor (existing DO), AI03 Gateway (existing), Cloudflare Workers AI (STT/TTS models)
- **PR target:** ~300 lines (TutorSession changes + tests)

## Problem Statement

The AI tutor works well for text — learners type questions, get grounded answers with citations. But typing is slow and detached. Learners and stakeholders want a more natural, conversational experience: speak questions aloud, hear answers spoken back, and see a tutor persona that brings the interaction to life.

## Solution

Extend the existing `TutorSession` Durable Object with voice input (STT) and voice output (TTS) over the existing WebSocket. Add a `TutorPersona` concept — a configurable tutor identity with a voice and portrait image — that drives browser-side 2D lip-sync animation. No new workers, no new HTTP endpoints. Voice is a modality on the same tutor session.

## User Stories

1. As a learner, I want to speak my question into the microphone, so that I can interact with the tutor hands-free while watching lesson content.
2. As a learner, I want the tutor to speak its answer aloud, so that I can listen without reading the screen.
3. As a learner, I want to see a friendly tutor face animate while speaking, so that the interaction feels personal and engaging.
4. As a learner, I want to switch between typing and speaking seamlessly in the same conversation, so that I can choose the best input method for my situation.
5. As a learner, I want the text answer to appear alongside the spoken answer, so that I can read along or refer back to citations.
6. As a learner without a microphone, I want to type my question and still hear the tutor speak the answer, so that voice output works even when voice input is unavailable.
7. As a learner without speakers, I want to speak my question and read the answer as text, so that voice input works even when audio output is unavailable.
8. As a learner, I want to see what the tutor heard (transcription) in the chat, so that I can catch any speech recognition errors.
9. As a platform admin, I want to define a pool of tutor personas per course, so that each course can have a distinct tutor identity.
10. As a learner, I want to pick my preferred tutor persona from the course's available pool, so that I can choose a voice and appearance I like.
11. As a developer, I want the voice pipeline to work alongside the existing text pipeline without code duplication, so that we don't maintain two separate Q&A systems.
12. As a developer, I want voice failures to degrade gracefully to text-only mode, so that the tutor remains usable even when STT or TTS is unavailable.
13. As an operator, I want latency from end-of-speech to first spoken word under 1.5 seconds, so that the voice interaction feels responsive.
14. As an operator, I want observable spans for STT and TTS alongside existing LLM spans, so that I can monitor voice pipeline health.

## Implementation Decisions

### Architecture: Extend Existing DO, Not a Separate System

Voice input and output are new modalities on the existing `TutorSession` Durable Object. The same session handles both text and voice exchanges, maintaining a single conversation history in SQLite. The existing `buildGroundedPrompt()` method, Vectorize query, and AI03 Gateway call are completely unchanged.

### Protocol: New WebSocket Message Types

The existing WebSocket at `GET /tutor/ws` already handles `{"type":"ask",...}` for text. Voice adds three new message types:

**Client → Server:**
- `{"type":"ask_voice", "audio":"<base64-wav>", "learner_id":"...", "lesson_id":"...", "course_id":"...", "org_id":"...", "module_id?":"..."}` — Voice question with raw audio. The DO runs STT, then feeds text into the existing pipeline.
- `{"type":"ask_tts_only", "question":"...", ...}` — Text question, voice answer only. Skipline STT, run LLM + TTS.

**Server → Client:**
- `{"type":"transcript", "text":"..."}` — What STT heard. Sent before the answer, for transparency.
- `{"type":"audio", "data":"<base64-pcm>", "chunk_index":N}` — TTS audio chunk. Streamed as LLM answer is spoken.
- `{"type":"tts_done"}` — All audio chunks delivered.
- `{"type":"mode", "mode":"voice-full"|"text-only"|...}` — Current interaction mode, sent on connect.

Existing message types (`token`, `citations`, `done`, `error`) continue unchanged.

### TTS: Sentence-Level Streaming

TTS uses `WorkersAITTS` with `@cf/deepgram/aura-1` on Workers AI. The LLM streams tokens. After the text stream completes, the full answer text is sent to TTS. TTS returns audio chunks that are forwarded over the WebSocket as base64-encoded PCM.

> Decision: Generate TTS from the complete answer text (not individual tokens). Sentence-level TTS from streaming tokens adds complexity (prosody breaks at sentence boundaries) without meaningful latency reduction. The full answer is available within 2-3s of the question; adding 300ms of TTS generation is imperceptible to the learner.

### STT: Ephemeral, Fire-and-Forget

STT uses `WorkersAIFluxSTT` on Workers AI. Raw audio arrives as base64-encoded WAV in the WebSocket message. The DO calls STT, gets transcribed text, sends the transcript to the client, then feeds the text into the existing `buildGroundedPrompt()` → AI03 pipeline. The raw audio is not stored — it lives only in the WebSocket message and is discarded after transcription.

### TutorPersona: Per-Course Pool, Learner-Choice

A `TutorPersona` is a configured tutor identity stored in D1 (shared across workers). Each course has a pool of available personas. The learner picks their preferred persona, which determines the TTS voice and portrait image.

Schema:
```
personas table:
  id, course_id, org_id, name, voice_id, portrait_image_url, tone_profile
```

The `voice_id` maps to a WorkersAITTS voice (e.g., `@cf/deepgram/aura-1`). The `portrait_image_url` is a static illustration (SVG/PNG) that the frontend uses for browser-side lip-sync animation. Persona configuration is out of scope for this worker — it's a D1 migration and admin UI concern. This worker only reads the selected persona to configure TTS.

### Avatar: Browser-Side, Not Server-Side

The avatar face is animated entirely in the browser using the Web Audio API. The browser receives audio chunks from the WebSocket, plays them through an `<audio>` element, and simultaneously uses an `AnalyserNode` to extract frequency data. This frequency data drives mouth movement on a 2D illustration (SVG or canvas). Zero server-side generation, zero additional latency, zero per-use cost.

### Degradation Paths

| Failure | Behavior | ai_status |
|---------|----------|-----------|
| STT empty / error | Send `{"type":"error","code":"stt_failed"}` to client. Tutor remains connected. Learner can type instead. | `"degraded"` |
| TTS unavailable | Deliver text-only answer. No audio chunks sent. Conversation continues. | `"degraded"` |
| AI03 down | Same as existing text degradation — `"ai_status":"degraded"` with error message. | `"degraded"` |

### Observability

New spans, following existing pattern in `observability.ts`:

```
voice.ask { modality, learner_id, org_id, duration_ms }
  ├─ voice.stt { duration_ms, transcript_length, status }
  ├─ voice.tts { duration_ms, audio_bytes, chunk_count, status }
  └─ (existing spans: data.embed, data.vectorize, ai_gateway.generate)
```

## Testing Decisions

### Seam: WebSocket Message Handler

The highest test seam is `TutorSession.webSocketMessage()`. All voice logic lives behind this single method. Tests send WebSocket messages and assert the messages received in response.

**Test categories (following existing pattern in `workers/ai-tutor/test/index.test.ts`):**
- Protocol validation — malformed `ask_voice` messages return errors
- STT mock — `env.AI.run("@cf/openai/whisper", ...)` returns transcribed text
- TTS mock — `env.AI.run("@cf/deepgram/aura-1", ...)` returns audio chunks
- Pipeline integration — voice question → transcript sent → text tokens stream → audio chunks stream → done
- Degradation — STT failure → text-only fallback, TTS failure → text-only fallback
- Span injection — `voice.ask`, `voice.stt`, `voice.tts` spans appear in console.log
- Empty audio — no transcript, error sent to client
- Mode messages — `mode` sent on connect, `transcript` sent before answer

**Existing test infrastructure reused:**
- `createMockGateway` — mocks AI03 service binding (unchanged)
- `createLlmResponse` — returns `{response: "..."}` for LLM (unchanged)
- `spyOnSpans` from `test-utils.ts` — captures console.log for span assertions
- Vitest `cloudflare:test` pool with mock bindings

**What makes a good test:** Assert the messages sent on the WebSocket, not the internal implementation. Don't test that `handleVoiceAsk()` is called — test that sending `ask_voice` results in `transcript` + `token` + `audio` messages in correct order.

## Out of Scope

- Persona CRUD (D1 migration, admin UI) — this is configuration, not voice pipeline
- Persona selection UI — frontend concern
- Avatar animation implementation — frontend concern (browser Web Audio API + 2D rendering)
- Voice activity detection (VAD) — client-side concern (browser captures audio, sends when user stops speaking)
- Multi-language STT/TTS — initial implementation is English only
- Audio storage/replay — audio is ephemeral by design
- Conversation history including audio — text is canonical, audio is not persisted
- Real-time streaming avatar (HeyGen, Azure Voice Live) — evaluated and rejected on cost grounds
- Freepik/VEED lip-sync API integration — evaluated and rejected on cost grounds ($2.40–$4.50/answer)

## Further Notes

- The existing `messages` table in DO SQLite stores `(role, content)` — unchanged. Voice exchanges store the same text content. Audio is ephemeral.
- The Cloudflare Voice Agents SDK (`@cloudflare/voice`) was considered but rejected. Direct Workers AI calls (`WorkersAIFluxSTT`, `WorkersAITTS`) are simpler, avoid a framework dependency, and integrate cleanly with the existing DO pattern.
- Founderz uses Azure OpenAI Realtime + Freepik for their Fellows. We achieve the same effect (real-time voice + animated persona) with Workers AI (STT/TTS) + browser lip-sync, at zero third-party cost.
- Latency promise: ≤1.5s TTFA (Time to First Audio), ≤3s to complete answer. See `docs/voice-tutor-kpis.md` for full SLOs.
