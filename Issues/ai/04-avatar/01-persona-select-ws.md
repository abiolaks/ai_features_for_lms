# 01 — Persona selection over WebSocket

**What to build:** Learner selects a tutor character from a catalog → browser sends `select_persona` message over the existing WebSocket → Worker validates persona_id, stores selection in session state, and re-sends the `mode` message with the chosen persona config. Changing mid-session replaces the active persona immediately. No UI yet — just the protocol.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `select_persona` message type handled in `webSocketMessage()`: `{ type: "select_persona", persona_id: string }`
- [ ] Persona catalog: hardcoded array of 3-5 `TutorPersona` objects (Aura, Marcus, Jenny, Hiro, Sage) with real Azure voice_ids
- [ ] Unknown `persona_id` returns `{ type: "error", code: "unknown_persona" }`
- [ ] Successful selection re-sends `mode` message: `{ type: "mode", modes: [...], active_mode: "...", persona: TutorPersona }`
- [ ] Persona stored in DO instance state (SQLite or instance variable) — survives reconnect within same session
- [ ] Existing `mode` message on connect uses the stored persona if one was previously selected, otherwise DEFAULT_PERSONA
- [ ] Unit test: send `select_persona` → verify `mode` response with correct persona
- [ ] Unit test: send unknown persona_id → verify error
- [ ] Unit test: select, reconnect (new WS connection, same learner_id) → verify persona persists
- [ ] Existing 33 tests still pass
