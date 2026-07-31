# 03 — Full voice pipeline + degradation + observability

**What to build:** Wire voice input (STT) and voice output (TTS) into a complete end-to-end pipeline: speak a question → hear the answer spoken, with text and citations alongside. Add degradation handling so the tutor stays usable when voice components fail.

The `handleVoiceAsk()` handler from ticket 01 now calls `generateTTS()` from ticket 02 after the text stream completes. When STT or TTS fails, the pipeline degrades to text-only mode without dropping the WebSocket session. Top-level spans track the full voice interaction.

**Blocked by:** 01 (voice input), 02 (voice output). Both must be green before integration.

**Status:** ready-for-agent

- [ ] `handleVoiceAsk()` calls `generateTTS()` after text stream completes (integrating 01 + 02)
- [ ] Full pipeline test: `ask_voice` → `transcript` → `citations` → `token` × N → `audio` × N → `tts_done` → `done` (all in correct order)
- [ ] Degradation: STT fails → `{"type":"error","code":"stt_failed"}` → session stays connected → learner can type instead
- [ ] Degradation: TTS fails → text tokens delivered normally → no audio chunks → `done` still sent → `ai_status: "degraded"` in span
- [ ] Degradation: AI03 down → same behavior as existing text pipeline (error, no crash)
- [ ] Top-level `voice.ask` span wraps full pipeline: `modality`, `learner_id`, `org_id`, `duration_ms`
- [ ] `voice.stt` sub-span: `duration_ms`, `transcript_length`, `status`
- [ ] `voice.tts` sub-span: `duration_ms`, `audio_bytes`, `chunk_count`, `status`
- [ ] All existing text-pipeline tests pass (no regression on citations, scope expansion, history, prompt injection guards)
- [ ] Verify test timing: TTFA ≤1.5s achievable in mock environment (validates pipeline structure, not production latency)
