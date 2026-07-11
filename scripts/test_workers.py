#!/usr/bin/env python3
"""
Production Smoke Test — AI Workers for LMS
==========================================
Tests all 4 deployed AI workers with real requests.
Shows team what's live and working before LMS integration.

Usage:
  python3 scripts/test_workers.py

Requires: Python 3.8+ (stdlib only — no pip installs needed)
"""

import json
import subprocess
import sys
import time
import urllib.request
import urllib.error
from dataclasses import dataclass, field

# ═══════════════════════════════════════════════════════
#  Config
# ═══════════════════════════════════════════════════════

BASE_URLS = {
    "ai-gateway":   "https://ai-gateway.yomi-alarape.workers.dev",
    "ai-indexing":  "https://ai-indexing.yomi-alarape.workers.dev",
    "ai-tutor":     "https://ai-tutor.yomi-alarape.workers.dev",
    "ai-paths":     "https://ai-paths.yomi-alarape.workers.dev",
}

TEST_ORG = "test-org-2026"
TEST_LEARNER = "demo-learner-01"

HEADERS = {
    "Content-Type": "application/json",
    "Origin": "https://learning.lumerax.co",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
}


# ═══════════════════════════════════════════════════════
#  Helpers
# ═══════════════════════════════════════════════════════

@dataclass
class Result:
    name: str
    passed: bool
    status: int = 0
    duration_ms: float = 0.0
    response: dict | str = ""
    cors_headers: dict = field(default_factory=dict)
    error: str = ""


def post(url: str, body: dict, timeout: int = 60) -> tuple[int, dict, dict]:
    """POST JSON and return (status, response_json, headers_dict)."""
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers=HEADERS, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            cors = {
                k: resp.getheader(k)
                for k in [
                    "Access-Control-Allow-Origin",
                    "Access-Control-Allow-Methods",
                    "Access-Control-Allow-Headers",
                ]
                if resp.getheader(k)
            }
            raw = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(raw), cors
            except json.JSONDecodeError:
                return resp.status, raw, cors
    except urllib.error.HTTPError as e:
        body_text = ""
        try:
            body_text = e.read().decode("utf-8")
        except Exception:
            pass
        return e.code, {"_raw": body_text}, {}
    except Exception as e:
        return 0, {"_error": str(e)}, {}


def get(url: str, timeout: int = 30) -> tuple[int, dict, dict]:
    """GET JSON and return (status, response_json, headers_dict)."""
    req = urllib.request.Request(url, headers=HEADERS, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(raw), {}
            except json.JSONDecodeError:
                return resp.status, raw, {}
    except urllib.error.HTTPError as e:
        body_text = ""
        try:
            body_text = e.read().decode("utf-8")
        except Exception:
            pass
        return e.code, {"_raw": body_text}, {}
    except Exception as e:
        return 0, {"_error": str(e)}, {}


def options(url: str) -> tuple[int, dict]:
    """Send OPTIONS preflight and check CORS headers (uses curl to bypass WAF)."""
    try:
        result = subprocess.run([
            "curl", "-s", "-D", "-", "-o", "/dev/null",
            "-X", "OPTIONS",
            "-H", "Origin: https://learning.lumerax.co",
            "-H", "Access-Control-Request-Method: POST",
            "-H", "Access-Control-Request-Headers: Content-Type",
            url,
        ], capture_output=True, text=True, timeout=15)
        # Parse HTTP status and CORS headers from response headers
        cors: dict = {}
        status = 0
        for line in result.stdout.strip().split("\n"):
            if line.startswith("HTTP/"):
                status = int(line.split()[1])
            elif line.lower().startswith("access-control-allow-origin:"):
                cors["allow-origin"] = line.split(":", 1)[1].strip()
            elif line.lower().startswith("access-control-allow-methods:"):
                cors["allow-methods"] = line.split(":", 1)[1].strip()
        return status, cors
    except Exception as e:
        return 0, {"_error": str(e)}


def check(name: str, passed: bool, status: int, duration: float,
          response: dict | str, cors: dict = None, error: str = "") -> Result:
    return Result(
        name=name, passed=passed, status=status,
        duration_ms=duration, response=response,
        cors_headers=cors or {}, error=error,
    )


def fmt_json(obj, max_len=400):
    s = json.dumps(obj, indent=2, ensure_ascii=False)
    if len(s) > max_len:
        s = s[:max_len] + "\n... (truncated)"
    return s


# ═══════════════════════════════════════════════════════
#  Test 1 — CORS Preflight (all workers)
# ═══════════════════════════════════════════════════════

def test_cors_all() -> list[Result]:
    results = []
    # Only browser-facing workers need CORS.
    # ai-gateway & ai-indexing are internal (service bindings / webhook auth).
    endpoints = {
        "ai-tutor":     "/tutor/ask",
        "ai-paths":     "/paths/generate",
    }
    for name, path in endpoints.items():
        url = f"{BASE_URLS[name]}{path}"
        t0 = time.monotonic()
        status, cors = options(url)
        dt = (time.monotonic() - t0) * 1000

        origin_ok = cors.get("allow-origin") == "https://learning.lumerax.co"
        passed = status == 204 and origin_ok
        results.append(check(
            f"CORS preflight — {name}",
            passed, status, dt,
            cors,
            error="" if passed else f"origin={cors.get('allow-origin')}"
        ))
    return results


# ═══════════════════════════════════════════════════════
#  Test 2 — AI Gateway (real LLM call)
# ═══════════════════════════════════════════════════════

def test_gateway_generate() -> list[Result]:
    results = []
    url = f"{BASE_URLS['ai-gateway']}/generate"
    body = {
        "messages": [
            {
                "role": "user",
                "content": "In one sentence, explain what machine learning is."
            }
        ],
        "tier": "standard",
        "org_id": TEST_ORG,
    }

    t0 = time.monotonic()
    status, resp, cors = post(url, body)
    dt = (time.monotonic() - t0) * 1000

    has_response = isinstance(resp, dict) and "response" in resp
    has_model = isinstance(resp, dict) and "model_used" in resp
    passed = status == 200 and has_response and has_model

    results.append(check(
        "AI Gateway — generate (real LLM)",
        passed, status, dt, resp,
        error="" if passed else f"status={status}, has_response={has_response}"
    ))
    return results


# ═══════════════════════════════════════════════════════
#  Test 3 — AI Gateway streaming (SSE)
# ═══════════════════════════════════════════════════════

def test_gateway_stream() -> list[Result]:
    results = []
    url = f"{BASE_URLS['ai-gateway']}/stream"
    body = {
        "messages": [
            {"role": "user", "content": "Count from 1 to 5."}
        ],
        "tier": "standard",
        "org_id": TEST_ORG,
    }

    t0 = time.monotonic()
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers=HEADERS, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8")
            dt = (time.monotonic() - t0) * 1000
            content_type = resp.getheader("Content-Type", "")
            has_sse = "text/event-stream" in content_type
            has_data = "data:" in raw
            passed = resp.status == 200 and has_sse and has_data
            results.append(check(
                "AI Gateway — stream (SSE)",
                passed, resp.status, dt,
                raw[:300] if not passed else f"SSE stream OK — {raw.count('data:')} events",
                error="" if passed else f"content_type={content_type}"
            ))
    except Exception as e:
        dt = (time.monotonic() - t0) * 1000
        results.append(check(
            "AI Gateway — stream (SSE)",
            False, 0, dt, {},
            error=str(e)
        ))
    return results


# ═══════════════════════════════════════════════════════
#  Test 4 — AI Indexing diagnostic endpoints
# ═══════════════════════════════════════════════════════

def test_indexing_diagnostics() -> list[Result]:
    results = []

    # GET /videos — list Stream videos
    t0 = time.monotonic()
    status, resp, _ = get(f"{BASE_URLS['ai-indexing']}/videos")
    dt = (time.monotonic() - t0) * 1000
    passed = status == 200 and isinstance(resp, dict)
    results.append(check(
        "AI Indexing — GET /videos",
        passed, status, dt, resp,
        error="" if passed else f"status={status}"
    ))

    # GET /r2-list — list R2 objects
    t0 = time.monotonic()
    status, resp, _ = get(f"{BASE_URLS['ai-indexing']}/r2-list")
    dt = (time.monotonic() - t0) * 1000
    passed = status == 200 and isinstance(resp, dict)
    results.append(check(
        "AI Indexing — GET /r2-list",
        passed, status, dt, resp,
        error="" if passed else f"status={status}"
    ))

    # GET /env-check — env vars
    t0 = time.monotonic()
    status, resp, _ = get(f"{BASE_URLS['ai-indexing']}/env-check")
    dt = (time.monotonic() - t0) * 1000
    passed = status == 200 and isinstance(resp, dict)
    results.append(check(
        "AI Indexing — GET /env-check",
        passed, status, dt, resp,
        error="" if passed else f"status={status}"
    ))

    return results


# ═══════════════════════════════════════════════════════
#  Test 5 — AI Tutor (real Q&A)
# ═══════════════════════════════════════════════════════

def test_tutor_ask() -> list[Result]:
    results = []
    url = f"{BASE_URLS['ai-tutor']}/tutor/ask"
    body = {
        "question": "What can I learn from this course?",
        "learner_id": TEST_LEARNER,
        "lesson_id": "demo-lesson-01",
        "course_id": "demo-course",
        "org_id": TEST_ORG,
    }

    t0 = time.monotonic()
    status, resp, cors = post(url, body)
    dt = (time.monotonic() - t0) * 1000

    has_answer = isinstance(resp, dict) and "answer" in resp
    has_citations = isinstance(resp, dict) and "citations" in resp
    cors_ok = cors.get("Access-Control-Allow-Origin") == "https://learning.lumerax.co"
    passed = (status == 200 and has_answer and has_citations and cors_ok)

    results.append(check(
        "AI Tutor — POST /tutor/ask",
        passed, status, dt, resp,
        cors=cors,
        error="" if passed else f"has_answer={has_answer}, has_citations={has_citations}, cors_ok={cors_ok}"
    ))
    return results


def test_tutor_clear() -> list[Result]:
    results = []
    url = f"{BASE_URLS['ai-tutor']}/tutor/clear"
    body = {"learner_id": TEST_LEARNER}

    t0 = time.monotonic()
    status, resp, cors = post(url, body)
    dt = (time.monotonic() - t0) * 1000

    cors_ok = cors.get("Access-Control-Allow-Origin") == "https://learning.lumerax.co"
    is_cleared = isinstance(resp, dict) and resp.get("status") == "cleared"
    passed = status == 200 and is_cleared and cors_ok

    results.append(check(
        "AI Tutor — POST /tutor/clear",
        passed, status, dt, resp,
        cors=cors,
        error="" if passed else f"status={status}"
    ))
    return results


# ═══════════════════════════════════════════════════════
#  Test 6 — AI Paths (real learning path generation)
# ═══════════════════════════════════════════════════════

def test_paths_generate() -> list[Result]:
    results = []
    url = f"{BASE_URLS['ai-paths']}/paths/generate"
    body = {
        "learner_id": TEST_LEARNER,
        "org_id": TEST_ORG,
        "profile": {
            "skills": ["Python", "SQL"],
            "goals": "Become a machine learning engineer",
            "experience_level": "intermediate",
            "streak_days": 12,
            "points": 450,
        },
        "catalogue": [
            {"title": "Machine Learning Foundations", "difficulty": "intermediate", "category": "AI"},
            {"title": "Deep Learning with PyTorch", "difficulty": "advanced", "category": "AI", "prerequisites": ["Machine Learning Foundations"]},
            {"title": "Data Engineering 101", "difficulty": "beginner", "category": "Data"},
            {"title": "Natural Language Processing", "difficulty": "advanced", "category": "AI", "prerequisites": ["Machine Learning Foundations"]},
            {"title": "Python for Data Science", "difficulty": "beginner", "category": "Programming"},
            {"title": "MLOps in Production", "difficulty": "advanced", "category": "AI", "prerequisites": ["Machine Learning Foundations", "Deep Learning with PyTorch"]},
            {"title": "Statistics for ML", "difficulty": "intermediate", "category": "Math"},
        ],
        "progress": [
            {"title": "Python for Data Science", "status": "completed"},
            {"title": "Data Engineering 101", "status": "in_progress", "progress_pct": 60},
        ],
    }

    t0 = time.monotonic()
    status, resp, cors = post(url, body)
    dt = (time.monotonic() - t0) * 1000

    has_path = isinstance(resp, dict) and "path" in resp
    has_status = isinstance(resp, dict) and "ai_status" in resp
    path_len = len(resp.get("path", [])) if has_path else 0
    cors_ok = cors.get("Access-Control-Allow-Origin") == "https://learning.lumerax.co"
    # Accept both generated and insufficient_data (LMS may not be reachable)
    ai_ok = resp.get("ai_status") in ("generated", "insufficient_data")
    passed = status == 200 and has_path and has_status and ai_ok and cors_ok

    # Format path nicely for display
    path_preview = ""
    if has_path:
        path_preview = f"\n  Path ({resp['ai_status']}, {path_len} courses):"
        for c in resp["path"]:
            path_preview += f"\n    {c['order']}. {c['course_title']}"
            if c.get("why_this_fits"):
                path_preview += f"\n       → {c['why_this_fits']}"

    results.append(check(
        f"AI Paths — POST /paths/generate{path_preview}",
        passed, status, dt, resp,
        cors=cors,
        error="" if passed else f"has_path={has_path}, path_len={path_len}"
    ))
    return results


# ═══════════════════════════════════════════════════════
#  Main
# ═══════════════════════════════════════════════════════

def main():
    print("=" * 72)
    print("  AI Workers — Production Smoke Test")
    print("=" * 72)
    print(f"  Org:      {TEST_ORG}")
    print(f"  Learner:  {TEST_LEARNER}")
    print(f"  Frontend: https://learning.lumerax.co")
    print()

    all_results: list[Result] = []

    # Phase 1: CORS preflight (fast, no AI calls)
    print("─── Phase 1: CORS Preflight ───")
    for r in test_cors_all():
        all_results.append(r)
        icon = "✅" if r.passed else "❌"
        print(f"  {icon} {r.name}  ({r.status}, {r.duration_ms:.0f}ms)")

    # Phase 2: AI Gateway
    print("\n─── Phase 2: AI Gateway ───")
    for r in test_gateway_generate():
        all_results.append(r)
        icon = "✅" if r.passed else "❌"
        preview = ""
        if r.passed and isinstance(r.response, dict):
            preview = f" → model={r.response.get('model_used','?')}, tokens={r.response.get('tokens_used','?')}"
            ans = r.response.get("response", "")
            if ans:
                preview += f"\n    Answer: {ans[:150]}..."
        print(f"  {icon} {r.name}  ({r.status}, {r.duration_ms:.0f}ms){preview}")

    for r in test_gateway_stream():
        all_results.append(r)
        icon = "✅" if r.passed else "❌"
        print(f"  {icon} {r.name}  ({r.status}, {r.duration_ms:.0f}ms)")

    # Phase 3: AI Indexing diagnostics
    print("\n─── Phase 3: AI Indexing ───")
    for r in test_indexing_diagnostics():
        all_results.append(r)
        icon = "✅" if r.passed else "❌"
        preview = ""
        if r.passed and isinstance(r.response, dict):
            # Show count of items if available
            for key in ["videos", "objects", "bindings"]:
                val = r.response.get(key)
                if isinstance(val, list):
                    preview = f" → {len(val)} {key}"
                    break
        print(f"  {icon} {r.name}  ({r.status}, {r.duration_ms:.0f}ms){preview}")

    # Phase 4: AI Tutor
    print("\n─── Phase 4: AI Tutor ───")
    for r in test_tutor_ask():
        all_results.append(r)
        icon = "✅" if r.passed else "❌"
        preview = ""
        if isinstance(r.response, dict):
            ans = r.response.get("answer", "")
            n_cite = len(r.response.get("citations", []))
            preview = f" → citations={n_cite}"
            if ans:
                preview += f"\n    Answer: {ans[:150]}..."
        print(f"  {icon} {r.name}  ({r.status}, {r.duration_ms:.0f}ms){preview}")

    for r in test_tutor_clear():
        all_results.append(r)
        icon = "✅" if r.passed else "❌"
        print(f"  {icon} {r.name}  ({r.status}, {r.duration_ms:.0f}ms)")

    # Phase 5: AI Paths
    print("\n─── Phase 5: AI Paths ───")
    for r in test_paths_generate():
        all_results.append(r)
        icon = "✅" if r.passed else "❌"
        preview = ""
        if isinstance(r.response, dict):
            path = r.response.get("path", [])
            status_label = r.response.get("ai_status", "?")
            preview = f" → {status_label}, {len(path)} courses"
        print(f"  {icon} {r.name}  ({r.status}, {r.duration_ms:.0f}ms){preview}")

    # ═══════════════════════════════════════════════════
    #  Summary
    # ═══════════════════════════════════════════════════
    passed = [r for r in all_results if r.passed]
    failed = [r for r in all_results if not r.passed]
    total_duration = sum(r.duration_ms for r in all_results)

    print()
    print("=" * 72)
    print(f"  Results: {len(passed)}/{len(all_results)} passed  "
          f"({total_duration:.0f}ms total)")
    print("=" * 72)

    if failed:
        print("\n  ❌ FAILURES:")
        for r in failed:
            print(f"     - {r.name}")
            print(f"       status={r.status}, error={r.error}")
            if r.response:
                print(f"       response={fmt_json(r.response, 200)}")

    print()
    if not failed:
        print("  🎉 All workers healthy and responding!")
        print()
        print("  Ready for LMS integration:")
        print(f"    ai-gateway:   POST {BASE_URLS['ai-gateway']}/generate")
        print(f"    ai-indexing:  POST {BASE_URLS['ai-indexing']}/index")
        print(f"    ai-tutor:     POST {BASE_URLS['ai-tutor']}/tutor/ask")
        print(f"    ai-paths:     POST {BASE_URLS['ai-paths']}/paths/generate")
    print()

    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
