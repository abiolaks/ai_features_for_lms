# 09 — End-to-end wiring: ask → avatar speaks with lip-sync

**What to build:** Wire all previous tickets together into a single demo: learner asks a question (text or voice) → Worker generates grounded answer → Azure TTS produces audio + visemes → MouthCanvas animates the chosen persona's portrait with lip-sync. One complete vertical slice through the entire stack.

**Blocked by:** 07 — needs viseme animation loop, 08 — needs persona picker.

**Status:** ready-for-agent

- [ ] Full flow integration: persona pick → ask question → text tokens stream → done → Azure TTS → viseme timeline → MouthCanvas animation
- [ ] Text and voice input both produce avatar animation (via existing `handleStreamAsk` and `handleVoiceAsk` paths)
- [ ] Mid-session persona switch: change character → next answer uses new voice + portrait
- [ ] Answer text remains visible alongside avatar throughout animation
- [ ] New question interrupts current animation cleanly (cancel old audio, start new)
- [ ] Demo page: persona picker at top, chat transcript in middle, avatar with MouthCanvas on side
- [ ] Integration test: full pipeline with mocked Azure SDK → verify viseme sequence drives canvas
- [ ] Integration test: two rapid questions → second interrupts first, no ghost animation, no memory leak
- [ ] Performance: TTFA (time to first animation frame) ≤ 500ms after done message
- [ ] Smoke test: deploy to staging, record video of avatar speaking
