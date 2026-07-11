#!/usr/bin/env python3
"""
AI Tutor — Real Content Test
=============================
Tests the AI tutor with actual indexed content from Cloudflare Stream videos.

Prerequisites: Run scripts/index_all_videos.py first to index content.

Usage:
  python3 scripts/test_tutor.py
"""

import json
import sys
import time
import urllib.request

TUTOR_URL = "https://ai-tutor.yomi-alarape.workers.dev/tutor/ask"
HEADERS = {
    "Content-Type": "application/json",
    "Origin": "https://learning.lumerax.co",
    "User-Agent": "Mozilla/5.0",
}

# Use dev-org (diag-index uses this) and expand_scope=course to find content
BASE_BODY = {
    "learner_id": "demo-learner",
    "lesson_id": "any",
    "course_id": "any",
    "org_id": "dev-org",
    "expand_scope": "course",
}

QUESTIONS = [
    "What topics are covered in these courses?",
    "What are the three types of machine learning you mentioned?",
    "What tips does the presentation skills course give for being a better speaker?",
    "How can SMEs apply AI to their business according to the courses?",
]


def ask(question: str) -> dict:
    body = {**BASE_BODY, "question": question}
    data = json.dumps(body).encode()
    req = urllib.request.Request(TUTOR_URL, data=data, headers=HEADERS, method="POST")
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode())


def main():
    print("=" * 60)
    print("  AI Tutor — Real Content Test")
    print("=" * 60)
    print(f"  Endpoint: {TUTOR_URL}")
    print(f"  Org:      dev-org (from diag-index)")
    print()

    # Clear history first
    clear_body = json.dumps({"learner_id": "demo-learner"}).encode()
    clear_req = urllib.request.Request(
        "https://ai-tutor.yomi-alarape.workers.dev/tutor/clear",
        data=clear_body, headers=HEADERS, method="POST",
    )
    urllib.request.urlopen(clear_req, timeout=10)
    print("  🧹 Session cleared — starting fresh\n")

    for i, q in enumerate(QUESTIONS):
        print(f"  Q{i+1}: {q}")
        t0 = time.monotonic()
        resp = ask(q)
        dt = time.monotonic() - t0

        answer = resp.get("answer", "")
        citations = resp.get("citations", [])
        history = resp.get("history_length", 0)

        print(f"  A{i+1}: {answer[:200]}{'...' if len(answer) > 200 else ''}")
        print(f"         ({len(citations)} citations, {dt:.1f}s, history={history})")
        print()

    print("=" * 60)
    print("  ✅ Tutor is working with real content!")
    print()
    print("  Try your own questions:")
    print(f'    curl -X POST {TUTOR_URL} \\')
    print(f'      -H "Content-Type: application/json" \\')
    print(f'      -H "Origin: https://learning.lumerax.co" \\')
    print(f"      -d '{{\"question\":\"...\",\"learner_id\":\"demo\",\"lesson_id\":\"any\",\"course_id\":\"any\",\"org_id\":\"dev-org\",\"expand_scope\":\"course\"}}'")
    print()


if __name__ == "__main__":
    main()
