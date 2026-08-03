# 06 — Canvas compositor: portrait + mouth overlay

**What to build:** A React (or vanilla) component that takes a portrait image URL and mouth asset bundle, draws the portrait on a `<canvas>`, and overlays a mouth sprite at the defined anchor point. Supports manual control of which mouth shape to show — no animation yet, just static rendering.

**Blocked by:** 05 — needs mouth sprites loaded.

**Status:** ready-for-agent

- [ ] `MouthCanvas` component: props = `{ portraitUrl: string; mouthAssets: MouthAssetBundle; visemeId: number; width: number; height: number }`
- [ ] Renders a `<canvas>` element at specified dimensions
- [ ] On mount + prop change: draws portrait as background (scaled to fit, centered), overlays mouth sprite at anchor position
- [ ] `visemeId` outside 0-21 → draws mouth sprite 0 (rest/silence)
- [ ] Portrait image load failure → draws colored silhouette with white text initials (first letter of persona name)
- [ ] Canvas respects device pixel ratio for sharp rendering on Retina displays
- [ ] Component tests: render with `visemeId=0` (rest), `visemeId=14` (open jaw) — verify correct sprite drawn at anchor
- [ ] Component test: invalid `visemeId=99` → rest mouth drawn, no crash
- [ ] Component test: portrait URL 404 → silhouette rendered, no crash
- [ ] Component test: prop change from `visemeId=0` to `visemeId=21` → canvas re-renders with new mouth shape
