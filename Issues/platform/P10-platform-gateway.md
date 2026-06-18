# Platform Slice P10: Platform Gateway

- **Type:** AFK
- **Blocked by:** P03, P05, P06, P07, P08, P09 (all platform services must exist)
- **User stories covered:** Platform — unified entry point, single port, auth at the edge

## What to build

A reverse proxy / API gateway that sits in front of all platform services. One port (`8000`) for the entire LMS. Routes requests to the right backend service based on path prefix. Handles auth at the edge so individual services don't need to.

### Service: `services/gateway/`

FastAPI app on port `8000`. Uses `httpx.AsyncClient` to proxy requests to backend services.

### Route table

| Path prefix | Backend service | Port |
|------------|----------------|------|
| `/api/content/*` | Content Management (P03) | 8010 |
| `/api/accounts/*` | Learner Accounts (P05) | 8011 |
| `/api/catalogue/*` | Course Catalogue (P06) | 8012 |
| `/api/progress/*` | Enrollment & Progress (P07) | 8013 |
| `/api/quizzes/*` | Quiz Engine (P08) | 8014 |
| `/api/ai/*` | AI Gateway (future — routes to all AI services) | — |
| `/admin/*` | Admin Dashboard (P09) | 8015 |
| `/app/*` | Learner Dashboard (future — routes to Demo Dashboard AI13) | — |

### What the gateway does

1. **Receives** request on port 8000
2. **Validates auth** — checks `X-API-Key` header against P05's accounts DB (connects directly to SQLite, not via HTTP)
3. **Injects learner context** — adds `X-Learner-ID`, `X-Org-ID` headers to the proxied request
4. **Proxies** request to the correct backend service via `httpx`
5. **Returns** the backend's response as-is (streaming-compatible for future SSE endpoints)

### Gateway code (pseudocode)

```python
# services/gateway/main.py
# Routes requests to platform services. Handles auth at the edge
# so individual services trust X-Learner-ID header.

ROUTES = {
    "/api/content":    "http://content:8010",
    "/api/accounts":   "http://accounts:8011",
    "/api/catalogue":  "http://catalogue:8012",
    "/api/progress":   "http://progress:8013",
    "/api/quizzes":    "http://quizzes:8014",
}

@app.api_route("/{path:path}", methods=["GET","POST","PUT","DELETE","PATCH"])
async def proxy(request: Request, path: str):
    # Find matching backend
    for prefix, backend in ROUTES.items():
        if path.startswith(prefix.lstrip("/")):
            # Validate auth for non-public routes
            if not path.startswith("catalogue"):  # Catalogue is public
                api_key = request.headers.get("X-API-Key")
                learner = validate_key(api_key)  # Checks SQLite directly
                request.headers.__dict__["X-Learner-ID"] = learner.id
            
            # Proxy the request
            async with httpx.AsyncClient() as client:
                resp = await client.request(
                    method=request.method,
                    url=f"{backend}/{path}",
                    headers=dict(request.headers),
                    content=await request.body(),
                )
            return Response(content=resp.content, status_code=resp.status_code)
    
    raise HTTPException(404)
```

### Why a gateway

- **One port** for the frontend (`localhost:8000`)
- **Auth at the edge** — individual services trust `X-Learner-ID` header (internal-only, never exposed externally)
- **Future:** rate limiting, request logging, CORS headers all in one place
- **AI services** later plug into the same gateway under `/api/ai/*`

### Docker Compose update

The gateway is the only service exposed to the host. All others are internal:
```yaml
gateway:
  build: ./services/gateway
  ports: ["8000:8000"]
  depends_on: [content, accounts, catalogue, progress, quizzes, admin]

content:
  build: ./services/content
  # No ports exposed — only reachable via gateway

# ... same for all other services
```

## Acceptance criteria

- [ ] `http://localhost:8000/api/catalogue` → returns catalogue data (proxied to P06)
- [ ] `http://localhost:8000/api/accounts/register` → creates learner (proxied to P05)
- [ ] Authenticated request → gateway validates key, injects X-Learner-ID
- [ ] Unauthenticated request to protected endpoint → returns 401 from gateway (backend never hit)
- [ ] Public endpoint (catalogue) → no auth required
- [ ] Invalid path → returns 404
- [ ] Backend service down → gateway returns 502 with service name
- [ ] Gateway health check: `GET /health` → returns 200 + status of all backends
- [ ] CORS headers set (allow localhost origins for dashboard development)
- [ ] Request ID added to every proxied request (for tracing)
- [ ] All backend services accessible via gateway, none directly exposed
- [ ] Unit tests: proxy routing, auth validation, error pass-through
- [ ] Integration tests: register via gateway → use key to access catalogue → enroll → check progress

## Blocked by

- P03 — Content Management
- P05 — Learner Accounts
- P06 — Course Catalogue
- P07 — Enrollment & Progress
- P08 — Quiz Engine
- P09 — Admin Dashboard

See `Issues/TECH_PRINCIPLES.md` for open-source stack and code principles.
