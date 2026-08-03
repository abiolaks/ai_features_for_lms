# 10 — Degradation fallback chain

**What to build:** Ensure the avatar experience degrades gracefully at every failure point. Azure unreachable → melotts fallback with amplitude mouth. Portrait image 404 → silhouette. AudioContext blocked → tap prompt. Text answer always delivered regardless of audio/viseme state. Learner never loses the answer.

**Blocked by:** 09 — needs full pipeline wired to test degradation paths.

**Status:** ready-for-agent

- [ ] Azure Speech SDK throws/network error → melotts TTS audio chunks play instead (existing path), mouth uses amplitude-based toggle
- [ ] Melotts also fails (3043 or similar) → no audio, mouth stays rest, text answer fully visible — no error modal, just silent
- [ ] Portrait URL returns 404 → colored circle with persona initials rendered, mouth animation still works on silhouette
- [ ] Single mouth sprite 404 → rest mouth used for that visemeId, other visemes unaffected
- [ ] AudioContext blocked by browser autoplay policy → "🔊 Tap to hear" overlay on avatar, context resumed on click/tap
- [ ] WebSocket disconnect during TTS → audio stops, avatar freezes at last frame, text answer preserved in chat
- [ ] Entire voice pipeline fails (STT + TTS both down) → text-only mode, avatar hidden, chat still works
- [ ] Degradation state surfaced in observability span: `avatar_status: "full" | "amplitude_only" | "text_only"`
- [ ] Unit test: mock Azure SDK throw → verify melotts fallback activates, amplitude mouth toggle starts
- [ ] Unit test: mock portrait 404 + melotts 3043 → verify silhouette renders, text visible, no crash
- [ ] Unit test: mock AudioContext state "suspended" → verify tap prompt rendered, context resumes on interaction
