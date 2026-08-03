# 01 — Voice input: speak a question, get a text answer

**What to build:** Learner speaks into the microphone → tutor transcribes the speech → runs the existing grounded Q&A pipeline → streams text tokens back over WebSocket. Types and protocol constants defined inline in `TutorSession.ts` (following existing pattern — `AskRequest`, `Citation`, etc. are already local).

The learner sends `{"type":"ask_voice","audio":"<base64-wav>",...}` on the existing WebSocket. The DO calls `WorkersAIFluxSTT`, sends the transcript to the client, then feeds the transcribed text into the existing `buildGroundedPrompt()` → AI03 → text streaming path. Existing `token`, `citations`, and `done` messages carry the answer.

**Blocked by:** None — can start immediately.

**Status:** done ✅

- [x] `TutorPersona` interface defined locally in `TutorSession.ts`: `{ name, voice_id, portrait_image_url, tone_profile }` (reused by ticket 02)
- [x] `InteractionMode` type: `"text-only" | "voice-full" | "stt-text-out" | "text-tts-out"`
- [x] `handleVoiceAsk()` method: receives `ask_voice` message → calls `WorkersAIFluxSTT` → sends `{"type":"transcript","text":"..."}` → delegates to existing text pipeline (same `buildGroundedPrompt` → AI03 → `handleStreamAsk` logic)
- [x] `webSocketMessage()` routes `"ask_voice"` type
- [x] `"mode"` message sent on WebSocket connect indicating available modes
- [x] Hardcoded default persona (e.g., voice_id `@cf/deepgram/aura-1`) — real config from admin UI is out of scope
- [x] STT mock test: mock returns transcribed text → verify transcript → token → citations → done flow
- [x] STT failure test: mock throws → client receives error → session stays connected → text fallback works
- [x] Empty audio test: zero-length → error, no pipeline call
- [x] Existing text-based tests still pass (no regression on `"ask"` type)
- [x] Observability: `voice.ask` span with `voice.stt` sub-span (duration_ms, transcript_length, status)
