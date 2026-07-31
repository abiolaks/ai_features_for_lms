#!/usr/bin/env python3
"""
AI Assistant Smoke Test — Platform Assistant (AI09)
====================================================
Tests the ai-assistant worker with real LMS data.

Usage:
  python3 scripts/test_assistant.py

Requires: Python 3.8+ (stdlib only)
"""

import json
import time
import urllib.request
import urllib.error

# ═══════════════════════════════════════════════════════
#  Config
# ═══════════════════════════════════════════════════════

# Update this after deployment
ASSISTANT_URL = "https://ai-assistant.yomi-alarape.workers.dev"

TEST_ORG = "dev-org"
TEST_LEARNER = "demo-learner"

HEADERS = {
    "Content-Type": "application/json",
    "Origin": "https://learning.lumerax.co",
    "User-Agent": "AssistantSmokeTest/1.0",
}


# ═══════════════════════════════════════════════════════
#  Helpers
# ═══════════════════════════════════════════════════════

def post(url: str, body: dict, timeout: int = 60) -> tuple:
    """POST JSON and return (status, response_dict, headers_dict)."""
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=HEADERS, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            cors = {}
            for k in ["Access-Control-Allow-Origin", "Access-Control-Allow-Methods"]:
                v = resp.getheader(k)
                if v:
                    cors[k] = v
            raw = resp.read().decode("utf-8")
            return resp.status, json.loads(raw), cors
    except urllib.error.HTTPError as e:
        body_text = ""
        try:
            body_text = e.read().decode("utf-8")
            return e.code, json.loads(body_text), {}
        except Exception:
            return e.code, {"_raw": body_text}, {}
    except Exception as e:
        return 0, {"_error": str(e)}, {}


def fmt_section(title: str):
    print(f"\n{'='*72}")
    print(f"  {title}")
    print(f"{'='*72}")


def print_answer(result: dict):
    answer = result.get("answer", result.get("error", "?"))
    citations = result.get("citations", [])
    suggestions = result.get("suggested_courses", [])
    history = result.get("history_length", "?")

    print(f"  Answer:        {answer[:300]}")
    if len(answer) > 300:
        print(f"                 ...({len(answer)} chars total)")
    print(f"  Citations:     {len(citations)}")
    for i, c in enumerate(citations[:3]):
        course = f" [course: {c.get('course_id', '?')}]" if c.get('course_id') else ""
        loc = f" ({c.get('location')})" if c.get('location') else ""
        print(f"    [{i+1}] {c.get('lesson_title', '?')}{course}{loc} (score: {c.get('score', 0):.2f})")
    if len(citations) > 3:
        print(f"    ... and {len(citations) - 3} more")
    print(f"  Suggestions:   {len(suggestions)}")
    for s in suggestions:
        print(f"    • {s.get('title', '?')} — {s.get('reason', '')}")
    print(f"  History depth: {history}")


# ═══════════════════════════════════════════════════════
#  Test Cases
# ═══════════════════════════════════════════════════════

def test_course_discovery():
    """Q: What courses cover Python?"""
    fmt_section("Test 1: Course Discovery")
    body = {
        "question": "What courses cover Python or programming?",
        "learner_id": TEST_LEARNER,
        "org_id": TEST_ORG,
    }
    t0 = time.monotonic()
    status, resp, cors = post(f"{ASSISTANT_URL}/assistant/ask", body)
    dt = (time.monotonic() - t0) * 1000

    print(f"  Status:  {status} ({dt:.0f}ms)")
    print(f"  CORS:    {cors.get('Access-Control-Allow-Origin', 'MISSING')}")
    print_answer(resp)

    has_answer = "answer" in resp and len(resp.get("answer", "")) > 20
    has_citations = "citations" in resp
    return status == 200 and has_answer and has_citations


def test_topic_explanation():
    """Q: What is machine learning?"""
    fmt_section("Test 2: Topic Explanation (platform-wide)")
    body = {
        "question": "What is machine learning and how is it used in business?",
        "learner_id": TEST_LEARNER,
        "org_id": TEST_ORG,
    }
    t0 = time.monotonic()
    status, resp, cors = post(f"{ASSISTANT_URL}/assistant/ask", body)
    dt = (time.monotonic() - t0) * 1000

    print(f"  Status:  {status} ({dt:.0f}ms)")
    print_answer(resp)

    return status == 200 and "answer" in resp


def test_prerequisite_question():
    """Q: What should I learn before Data Science?"""
    fmt_section("Test 3: Prerequisite / Path Question")
    body = {
        "question": "What should I learn before taking a Data Science course?",
        "learner_id": TEST_LEARNER,
        "org_id": TEST_ORG,
    }
    t0 = time.monotonic()
    status, resp, cors = post(f"{ASSISTANT_URL}/assistant/ask", body)
    dt = (time.monotonic() - t0) * 1000

    print(f"  Status:  {status} ({dt:.0f}ms)")
    print_answer(resp)

    return status == 200 and "answer" in resp


def test_conversation_memory():
    """Multi-turn: ask a question, then a follow-up that needs context."""
    fmt_section("Test 4: Multi-turn Conversation Memory")
    learner = "multi-turn-demo"

    # Turn 1
    body = {
        "question": "What topics are covered in the platform's AI courses?",
        "learner_id": learner,
        "org_id": TEST_ORG,
    }
    t0 = time.monotonic()
    status1, resp1, _ = post(f"{ASSISTANT_URL}/assistant/ask", body)
    dt1 = (time.monotonic() - t0) * 1000
    hist1 = resp1.get("history_length", 0)
    print(f"  Turn 1: {status1} ({dt1:.0f}ms), history={hist1}")

    # Turn 2 — "which one" refers to the previous answer
    body["question"] = "Which one of those would you recommend for a beginner?"
    t0 = time.monotonic()
    status2, resp2, _ = post(f"{ASSISTANT_URL}/assistant/ask", body)
    dt2 = (time.monotonic() - t0) * 1000
    hist2 = resp2.get("history_length", 0)
    print(f"  Turn 2: {status2} ({dt2:.0f}ms), history={hist2}")
    print_answer(resp2)

    # Clear session
    body_clear = {"learner_id": learner}
    t0 = time.monotonic()
    status_cl, resp_cl, _ = post(f"{ASSISTANT_URL}/assistant/clear", body_clear)
    dt_cl = (time.monotonic() - t0) * 1000
    print(f"\n  Clear:  {status_cl} ({dt_cl:.0f}ms), result={resp_cl.get('status')}")

    passed = (
        status1 == 200
        and status2 == 200
        and hist2 > hist1
        and status_cl == 200
    )
    return passed


def test_degraded_recovery():
    """Degraded: question with no matching content vs question that matches."""
    fmt_section("Test 5: Degraded / Recovery")

    # Ask about something definitely not indexed
    body = {
        "question": "What is the capital of Burkina Faso?",
        "learner_id": TEST_LEARNER,
        "org_id": TEST_ORG,
    }
    status1, resp1, _ = post(f"{ASSISTANT_URL}/assistant/ask", body)
    print(f"  Off-topic: {status1}")
    print(f"  Answer:    {resp1.get('answer', '?')[:150]}")
    print(f"  Citations: {len(resp1.get('citations', []))}")

    # Then ask about something that IS indexed
    body["question"] = "What can I learn on this platform?"
    status2, resp2, _ = post(f"{ASSISTANT_URL}/assistant/ask", body)
    print(f"\n  On-topic:  {status2}")
    print(f"  Citations: {len(resp2.get('citations', []))}")

    return status1 == 200 and status2 == 200


# ═══════════════════════════════════════════════════════
#  Main
# ═══════════════════════════════════════════════════════

def main():
    print("=" * 72)
    print("  AI Assistant (AI09) — Platform Smoke Test")
    print("=" * 72)
    print(f"  URL:      {ASSISTANT_URL}")
    print(f"  Org:      {TEST_ORG}")
    print(f"  Learner:  {TEST_LEARNER}")
    print()

    results = []
    for name, fn in [
        ("Course Discovery", test_course_discovery),
        ("Topic Explanation", test_topic_explanation),
        ("Prerequisite Question", test_prerequisite_question),
        ("Conversation Memory", test_conversation_memory),
        ("Degraded Recovery", test_degraded_recovery),
    ]:
        try:
            passed = fn()
            results.append((name, passed))
            icon = "✅" if passed else "❌"
            print(f"\n  {icon} {name}: {'PASS' if passed else 'FAIL'}")
        except Exception as e:
            results.append((name, False))
            print(f"\n  ❌ {name}: ERROR — {e}")

    # Summary
    passed = sum(1 for _, p in results if p)
    total = len(results)
    print(f"\n{'='*72}")
    print(f"  Results: {passed}/{total} passed")
    print(f"{'='*72}")

    if passed == total:
        print("\n  🎉 All smoke tests passed!")
    else:
        print(f"\n  ❌ {total - passed} test(s) failed")

    return 0 if passed == total else 1


if __name__ == "__main__":
    import sys
    sys.exit(main())
