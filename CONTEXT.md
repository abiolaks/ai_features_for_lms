# CONTEXT.md — AI Features for LMS

## Glossary

### TutorSession (existing)
A Durable Object representing one learner's conversation with the AI tutor. Stores history in SQLite. Supports HTTP RPC (`ask`) and WebSocket streaming. Persists across browser sessions per learner.

### TutorExchange (proposed)
A single question-answer pair within a TutorSession. Replaces the flat `Message` concept to accommodate multi-modal content.

> The existing `messages` table uses `(role, content)` as flat strings. This is adequate for text-only mode. Adding voice/avatar requires evolving to `TutorExchange` — each exchange records both the question and answer, each in one or more representations (text, audio, video).

A `TutorExchange` has:
- **question_text** — canonical question (from keyboard input OR transcribed from speech)
- **question_transcript** — raw STT output (displayed in chat for transparency, not used for correction)
- **answer_text** — LLM response as rich text (displayed, canonical)
- **answer_audio** — TTS output (ephemeral — streamed via WebSocket, never stored)

**Audio is ephemeral.** Text is canonical and stored in SQLite. Audio is transient — generated per-answer, streamed, consumed, discarded. Same approach as Founderz.

### TutorPersona
A configured identity for the tutor. Defined per-course (or per-org for global consistency). A course has a pool of available personas; the learner picks their preferred one.

A `TutorPersona` has:
- **name** — displayed name (e.g., "Dr. Ada")
- **voice_id** — TTS voice (Cloudflare WorkersAITTS `@cf/deepgram/aura-1` or ElevenLabs via Freepik API)
- **portrait_image_url** — static illustration (SVG/PNG) used for browser-side lip-sync animation
- **tone_profile** — voice steering hint ("friendly", "professional", "enthusiastic") passed to TTS

**Avatar is browser-side 2D lip-sync.** The portrait image is a static illustration. The browser uses the Web Audio API to extract frequency data from the TTS audio stream and drives mouth animation in real-time. Zero server-side generation, zero latency, zero per-use cost. Feels like a video call with a stylized character.

### InteractionMode (proposed)
The set of active input/output modalities for a TutorSession. A learner's device capabilities and preferences determine the mode.

| Mode | Input | Output | Requires |
|------|-------|--------|----------|
| `text-only` | Keyboard | Text (WebSocket) | Nothing extra |
| `stt-text-out` | Microphone | Text (WebSocket) | Mic permission |
| `text-tts-out` | Keyboard | Text + TTS audio | Speaker, TTS model |
| `voice-full` | Microphone | Text + TTS audio | Mic + speaker + TTS |
| `immersive` | Microphone | Text + TTS audio + Avatar | All of above + avatar model |

The TutorSession dynamically selects the mode based on device capability and learner preference. A single session can switch modes mid-conversation (e.g., learner unplugs headphones → falls back to text-only).

### AnswerDelivery
All channels deliver in parallel from the same WebSocket stream:

| t= | What | Transport |
|----|------|-----------|
| ~1.0s | First text token | WebSocket `{"type":"token","text":"..."}` |
| ~1.5s | First audio chunk | WebSocket `{"type":"audio","data":"<base64>"}` |
| ~1.5s | Avatar starts animating | Browser-side, driven by audio waveform (no server latency) |
| ~3.0s | All complete | — |

Text, audio, and avatar all deliver concurrently. No staggered phases — the browser plays audio and lip-syncs the avatar in real-time from the same audio stream.

---

## Design Decisions (Resolved)

All four ADRs from the grilling session are now closed:

1. **Avatar: browser-side 2D lip-sync.** No server-side video generation. Portrait illustration + Web Audio API frequency analysis drives mouth animation in real-time. Zero per-use cost, zero latency. Freepik evaluated and rejected (costs $2.40–$4.50 per answer, doesn't scale for an LMS).

2. **Audio storage: ephemeral.** Streamed via WebSocket, consumed by browser, discarded. Text is canonical in SQLite. Same approach as Founderz.

3. **TutorPersona scope: per-course pool, learner-choice.** Each course defines available personas. Learner picks their preferred one. Persona config stored in D1 or DO SQLite.

4. **Transcription: fire-and-forget.** No confirmation step. Show transcript in chat for transparency. Confirmation adds latency that breaks the voice interaction model. Fire-and-forget is what Founderz and Azure Voice Live do.

### Architecture Decision: Single DO, Multi-Modal

Voice + avatar extend the existing `TutorSession` DO — not a separate system. Same `buildGroundedPrompt()`, same Vectorize, same AI03 Gateway. Voice and avatar are new output modalities on the same exchange. One WebSocket multiplexes text tokens, audio chunks, and avatar status. No new workers needed.
