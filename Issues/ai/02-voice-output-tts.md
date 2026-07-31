# 02 — Voice output: type a question, hear the answer spoken

**What to build:** Learner types a question (existing text path) → tutor generates answer via existing pipeline → answer text is sent to TTS → audio chunks stream back over WebSocket alongside text tokens. Reuses `TutorPersona` type from ticket 01.

The DO calls `WorkersAITTS` with the complete answer text + persona `voice_id` after the LLM stream finishes. Audio chunks are base64-encoded PCM, sent as `{"type":"audio","data":"<base64>","chunk_index":N}` messages interleaved after text tokens. A `{"type":"tts_done"}` message signals the end.

**Blocked by:** 01 — needs `TutorPersona` type and protocol constants.

**Status:** ready-for-agent

- [ ] `generateTTS()` method: calls `WorkersAITTS` with answer text + persona voice_id → yields audio chunks as base64 PCM
- [ ] `handleStreamAsk()` augmented: after text stream finishes, calls `generateTTS()` and forwards `{"type":"audio",...}` chunks on WebSocket
- [ ] `"tts_done"` message sent after last audio chunk
- [ ] TTS mock test: mock returns chunked PCM → verify `audio` + `tts_done` messages in order after text tokens
- [ ] TTS failure test: mock throws → text tokens still delivered → no audio → no crash → `done` still sent
- [ ] Existing text-based tests still pass (no regression)
- [ ] Observability: `voice.tts` sub-span (duration_ms, audio_bytes, chunk_count, status)
