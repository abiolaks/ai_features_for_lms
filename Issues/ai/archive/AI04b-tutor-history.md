# Slice 4b: Tutor Conversation History

- **Type:** AFK
- **Blocked by (internal):** Slice 0, Slice 4a
- **Blocked by (external):** None (uses mock platform; UI retention notice is platform team scope — this slice returns the notice text)
- **User stories covered:** 13–18 (history CRUD, retention, purge)

## Parent

`docs/vertical-slices-phase-1.md` — Slice 4: In-Lesson Tutor (split — conversation history concern)

## What to build

Conversation history persistence for the Tutor. Stores Q&A pairs per learner per conversation, with automatic 30-day retention and learner-initiated full deletion. Exposes:

- `POST /tutor/history` — body: `{conversation_id, learner_id, question, answer, citations}` → stores the Q&A pair
- `GET /tutor/history/{conversation_id}` → returns all Q&A pairs for that conversation, ordered by timestamp
- `DELETE /tutor/history/{learner_id}` → wipes all conversations for that learner
- `GET /tutor/history/{learner_id}/notice` → returns the retention notice text: "Conversations older than 30 days are automatically deleted. You can clear your history at any time."

**30-day retention:**
- A background task (or on-read check) purges conversations where `last_updated > 30 days ago`
- Purge is hard-delete — no soft delete, no recovery
- Runs at least once per day; also checked on read

Storage: in-memory or sqlite for local dev/testing, PostgreSQL for production (env-configurable).

## Acceptance criteria

- [ ] POST /tutor/history → stores Q&A pair, returns 201
- [ ] GET /tutor/history/{conversation_id} → returns ordered list of Q&A pairs with citations
- [ ] DELETE /tutor/history/{learner_id} → all conversations for learner wiped, returns 204
- [ ] GET /tutor/history/{learner_id}/notice → returns retention notice text
- [ ] Conversations older than 30 days are automatically purged (verified by aging timestamps in test)
- [ ] Purged conversation → GET returns 404
- [ ] History is learner-scoped (conversation_id is unique per learner; no cross-learner access)
- [ ] Concurrent writes to same conversation → no data loss
- [ ] Storage backend switchable via env (`STORAGE_BACKEND=memory|sqlite|postgres`)
- [ ] Unit tests: CRUD operations, purge logic with time manipulation, concurrent write safety
- [ ] Integration tests: Slice 4a ask → store history → retrieve → delete → verify gone

## Blocked by

- Slice 0 (mock platform)
- Slice 4a (provides the Q&A pairs to store)
