# 05 — Mouth shape sprite asset bundle

**What to build:** Create or source 22 PNG mouth shape sprites (one per viseme ID, 0–21). Define the asset contract: dimensions, anchor point, naming convention. Provide a shared module that loads all 22 sprites and returns them keyed by visemeId. No rendering — just asset loading.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] 22 PNG sprites created or sourced, named `viseme-00.png` through `viseme-21.png`
- [ ] Sprite dimensions: 128×64px, transparent background, centered mouth shape in white or outline
- [ ] Anchor point defined: each sprite's mouth center at pixel (64, 32) — standardized for compositing
- [ ] `MouthAssetBundle` type: `Record<number, HTMLImageElement>` — maps `visemeId` to loaded Image
- [ ] `loadMouthAssets(): Promise<MouthAssetBundle>` — loads all 22 sprites, returns bundle
- [ ] Asset preloading on page load — sprites cached in module scope, no re-fetch per utterance
- [ ] Load failure: any sprite 404 → error logged, bundle returns partial set (missing sprites → rest mouth)
- [ ] Unit test: mock Image loading, verify bundle has 22 entries keyed 0-21
- [ ] Unit test: mock load failure → verify partial bundle, no crash
