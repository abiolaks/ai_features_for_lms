# Platform Slice P05: Learner Accounts

- **Type:** AFK
- **Blocked by:** P01, P02
- **User stories covered:** Platform — learner registration and authentication

## What to build

Simple learner account management with API key authentication. No passwords, no OAuth, no email verification. A learner signs up, gets an API key, and passes it as a header on every request.

### Service: `services/accounts/`

FastAPI app on port `8011`.

### Endpoints

```
POST   /register                Create learner account → returns API key
GET    /learners/{learner_id}   Get learner by ID
GET    /learners/me             Get authenticated learner's own profile
DELETE /learners/{learner_id}   Delete learner account
```

### Registration

`POST /register` — body: `{name, email?}`

1. Generate a unique `learner_id` (uuid4 hex)
2. Generate a random API key (32-char hex string)
3. Insert into `learners` table
4. Return: `{learner_id, name, email, api_key}`

**Important:** The API key is returned **once** at registration. It's stored hashed (sha256) in the DB. The plaintext is never stored after the response is sent. If a learner loses their key, they delete and re-register.

### Authentication middleware

`lib/auth.py` exports a FastAPI dependency:

```python
# lib/auth.py
from fastapi import Header, HTTPException
from lib.db import get_db

async def require_learner(x_api_key: str = Header(...)):
    key_hash = hashlib.sha256(x_api_key.encode()).hexdigest()
    learner = db.query(Learner).filter(Learner.api_key == key_hash).first()
    if not learner:
        raise HTTPException(401, "Invalid API key")
    return learner
```

Services use it as a route dependency:
```python
@app.get("/learners/me")
async def get_me(learner = Depends(require_learner)):
    return {"data": learner.to_dict()}
```

### API key in requests

All authenticated endpoints expect: `X-API-Key: {32_char_hex}`

For the demo dashboard (AI13), the key is stored in localStorage and sent on every fetch.

## Acceptance criteria

- [ ] POST /register with name → returns learner_id, name, and api_key
- [ ] POST /register same email → returns 409 (email must be unique if provided)
- [ ] POST /register no email → ok (email is optional)
- [ ] API key is 32 hex characters, returned in response
- [ ] API key stored as sha256 hash in DB (plaintext never persisted)
- [ ] GET /learners/me with valid X-API-Key → returns learner profile
- [ ] GET /learners/me with invalid key → returns 401
- [ ] GET /learners/me without header → returns 422 (FastAPI validation)
- [ ] DELETE /learners/{id} with valid key → deletes learner
- [ ] DELETE /learners/{id} with different learner's key → returns 403
- [ ] `require_learner` dependency importable from `lib.auth` by any service
- [ ] Unit tests: registration, key hashing, auth middleware, 401/403 responses
- [ ] Integration tests: register → use key to call /learners/me → delete → key stops working

## Blocked by

- P01 — needs `lib/db.py`, `lib/auth.py`
- P02 — needs `learners` table

See `Issues/TECH_PRINCIPLES.md` for open-source stack and code principles.
