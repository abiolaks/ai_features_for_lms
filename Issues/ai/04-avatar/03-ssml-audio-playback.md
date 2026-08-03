# 03 — SSML construction + audio playback

**What to build:** Given a persona's voice_id and cleaned answer text, construct valid SSML, send to Azure Speech SDK, receive WAV audio, and play it through the browser's AudioContext. Learner hears the answer spoken in the chosen voice. No viseme events consumed yet — just audio.

**Blocked by:** 02 — needs initialized Azure SDK.

**Status:** ready-for-agent

- [ ] `buildSSML(text: string, voiceId: string): string` helper — wraps text in `<speak>` with `<voice>` tag, sets `xml:lang="en-US"`, escapes XML special chars
- [ ] SSML includes prosody hints from `tone_profile` (e.g., "Warm" → `<prosody rate="-5%" pitch="+10Hz">`)
- [ ] `speakSSML(ssml: string): Promise<ArrayBuffer>` — calls Azure SDK `speakSsmlAsync()`, returns raw WAV bytes
- [ ] `playAudio(wavBytes: ArrayBuffer): Promise<void>` — decodes WAV via `AudioContext.decodeAudioData()`, schedules playback, returns Promise that resolves when playback ends
- [ ] Answer text longer than SSML limit → split into multiple utterances, play sequentially
- [ ] AudioContext blocked by autoplay policy → show "Tap to hear" button, resume context on user gesture
- [ ] Playback interrupted by new question → cancel current audio, start new utterance
- [ ] Unit test: mock `SpeechSynthesizer.speakSsmlAsync`, verify SSML content for different voice_ids
- [ ] Integration test: send real SSML to mock, verify WAV decoding chain works
