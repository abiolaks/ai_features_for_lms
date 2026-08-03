# 07 — Viseme-driven animation loop

**What to build:** A `requestAnimationFrame` loop that reads the current `AudioContext.currentTime`, looks up the active viseme from the timeline, and drives the MouthCanvas with the correct visemeId — including smooth blend interpolation between adjacent visemes for natural transitions.

**Blocked by:** 04 — needs viseme timeline capture, 06 — needs MouthCanvas component.

**Status:** ready-for-agent

- [ ] `VisemePlayer` class or hook: takes `timeline: VisemeTimelineEntry[]`, `audioContext: AudioContext`, `audioStartTime: number`
- [ ] `requestAnimationFrame` loop: every frame (~16ms), compute `elapsed = audioContext.currentTime - audioStartTime`
- [ ] Binary search timeline for the viseme active at `elapsed` milliseconds
- [ ] Blend factor: compute `t = (elapsed - currentViseme.audioOffsetMs) / nextViseme.audioOffsetMs - currentViseme.audioOffsetMs` — 0 to 1 between adjacent visemes
- [ ] Pass current `visemeId` and blend factor to MouthCanvas for smooth interpolation
- [ ] Loop stops when `elapsed` exceeds last viseme offset → hold final mouth shape (rest/0)
- [ ] New utterance starts → new animation loop replaces previous (cleanup old rAF)
- [ ] Performance: 60fps target, no frame drops from viseme lookups or canvas draws
- [ ] Unit test: fixed timeline, fake AudioContext with incrementing `currentTime` → verify visemeId sequence
- [ ] Unit test: empty timeline → rest mouth throughout, no crash
- [ ] Unit test: rapid viseme transitions (10ms between events) → blend factor never exceeds 1.0
