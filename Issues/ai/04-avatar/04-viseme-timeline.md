# 04 — Viseme event capture + timeline

**What to build:** Subscribe to Azure Speech SDK's `visemeReceived` event during synthesis. Build a typed timeline array from the events with `visemeId` and `audioOffset` in milliseconds. Log to console for verification — no rendering yet.

**Blocked by:** 03 — needs SSML + audio playback working.

**Status:** ready-for-agent

- [ ] `VisemeTimelineEntry` type: `{ visemeId: number; audioOffsetMs: number }`
- [ ] `subscribeVisemes(synthesizer: SpeechSynthesizer): VisemeTimelineEntry[]` — subscribes to `visemeReceived`, pushes entries to array
- [ ] Timeline sorted by `audioOffsetMs` ascending before returning
- [ ] Timestamp validation: no negative offsets, no out-of-order entries, `visemeId` in 0-21 range
- [ ] Zero-duration visemes (instant transitions) filtered out — minimum 30ms hold
- [ ] `visemeReceived` event firing verified: timeline has entries for a full sentence utterance
- [ ] Handler teardown: unsubscribe on synthesizer close to prevent memory leaks
- [ ] Unit test: mock `visemeReceived` events at known offsets, verify timeline is sorted and validated
- [ ] Unit test: zero-viseme utterance (silent answer) → empty timeline, no crash
