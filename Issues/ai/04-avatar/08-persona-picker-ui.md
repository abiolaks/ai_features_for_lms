# 08 — Persona picker UI

**What to build:** A dropdown or card grid component showing available tutor personas (name, portrait, voice description). Learner selects one → sends `select_persona` over WebSocket (ticket 01). Selection persists to `sessionStorage`. Component shows currently active persona with a highlight or checkmark.

**Blocked by:** 01 — needs persona select protocol over WS.

**Status:** ready-for-agent

- [ ] `PersonaPicker` component: renders list of personas from catalog (hardcoded 5 entries initially)
- [ ] Each card shows: portrait thumbnail, persona name, voice description ("Warm, patient"), voice accent ("US English, Female")
- [ ] Click/tap → sends `select_persona` message, shows loading state until `mode` response confirms
- [ ] Active persona highlighted with border/checkmark
- [ ] Selection persisted to `sessionStorage` — survives page refresh
- [ ] On page load, if stored persona_id exists, auto-send `select_persona` after WebSocket connects
- [ ] Responsive: horizontal scroll on mobile, grid on desktop
- [ ] Accessible: keyboard-navigable, screen reader announces selected persona
- [ ] Unit test: render picker, click persona → verify WS message sent with correct persona_id
- [ ] Unit test: verify active highlight updates on `mode` response
- [ ] Unit test: verify sessionStorage persistence across reload (mock storage)
