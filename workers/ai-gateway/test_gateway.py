#!/usr/bin/env python3
"""Test AI03 LLM Gateway — paste & run: python3 test_gateway.py"""

import urllib.request
import json

GATEWAY = "https://ai-gateway.yomi-alarape.workers.dev/generate"


def call(messages, tier, org_id):
    body = json.dumps({
        "messages": messages,
        "tier": tier,
        "org_id": org_id,
    }).encode()
    req = urllib.request.Request(GATEWAY, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "ai-gateway-test/1.0")
    with urllib.request.urlopen(req) as resp:
        return resp.status, json.loads(resp.read())


# ─── Test 1: Standard tier (llama-3.2) ───
print("=" * 50)
print("TEST 1: Standard tier → llama-3.2")
print("=" * 50)
status, data = call(
    messages=[{"role": "user", "content": "Hello"}],
    tier="standard",
    org_id="org-test",
)
print(f"Status: {status}")
print(json.dumps(data, indent=2))

# ─── Test 2: Quality tier (mistral-7b) ───
print()
print("=" * 50)
print("TEST 2: Quality tier → mistral-7b")
print("=" * 50)
status, data = call(
    messages=[{"role": "user", "content": "Explain gravity in one sentence."}],
    tier="quality",
    org_id="org-test",
)
print(f"Status: {status}")
print(json.dumps(data, indent=2))

# ─── Test 3: Budget exhausted → 429 ───
print()
print("=" * 50)
print("TEST 3: Exhausted budget → expects 429")
print("=" * 50)
try:
    status, data = call(
        messages=[{"role": "user", "content": "Hello"}],
        tier="standard",
        org_id="org-broke",
    )
    print(f"Status: {status}")
    print(json.dumps(data, indent=2))
except urllib.error.HTTPError as e:
    print(f"Status: {e.code}")
    print(json.dumps(json.loads(e.read()), indent=2))

print()
print("All tests complete.")
