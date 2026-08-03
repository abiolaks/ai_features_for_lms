# 02 — Azure Speech SDK initialization + auth

**What to build:** The LMS frontend loads the Azure Speech SDK (microsoft-cognitiveservices-speech-sdk npm package), authenticates with the Azure Speech resource key (injected via env/config, not hardcoded), and verifies the connection by listing available voices. No audio synthesis yet — just SDK init and authentication.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `microsoft-cognitiveservices-speech-sdk` installed as frontend dependency
- [ ] `SpeechConfig` created from subscription key + region, stored as module-level singleton
- [ ] API key read from environment variable or config endpoint — never committed to source
- [ ] `SpeechSynthesizer` instantiated successfully (no audio output yet)
- [ ] Voice list fetched: `synthesizer.getVoicesAsync()` returns 330+ voices with `shortName`, `locale`, `gender`
- [ ] Voice catalog filtered to en-US neural voices, stored in a typed array for the persona picker (ticket 08)
- [ ] Auth failure (wrong key, wrong region) → graceful error surfaced to console, falls back to melotts
- [ ] Unit test: mock `SpeechConfig` + `SpeechSynthesizer`, verify voice list is parsed correctly
- [ ] Unit test: mock auth failure → verify error is handled without crash
