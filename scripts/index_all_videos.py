#!/usr/bin/env python3
"""
Index all Cloudflare Stream videos into Vectorize so the AI tutor
can answer questions grounded in real lesson content.

Uses the diagnostic endpoint (no auth needed) — one-time setup.
After this, POST /tutor/ask with org_id="dev-org" will find content.

Usage:
  python3 scripts/index_all_videos.py
"""

import json
import sys
import time
import urllib.request

BASE = "https://ai-indexing.yomi-alarape.workers.dev"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
}

# Change this to match your production org_id
DEFAULT_ORG_ID = "dev-org"


def get_json(url: str) -> dict:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def index_video(video_id: str, title: str, org_id: str = "dev-org") -> dict:
    """Call GET /diag-index/:videoId/:title?org_id=... to index a single video."""
    safe_title = urllib.request.quote(title, safe="")
    url = f"{BASE}/diag-index/{video_id}/{safe_title}?org_id={urllib.request.quote(org_id)}"
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        return {"error": str(e)}


def main():
    print("=" * 60)
    print("  Indexing all Stream videos → Vectorize")
    print("=" * 60)

    # 1. List videos
    print("\n📋 Fetching video list...")
    data = get_json(f"{BASE}/videos")
    videos = data.get("videos", [])
    ready = [v for v in videos if v.get("status") == "ready"]
    print(f"   Found {len(videos)} total, {len(ready)} ready to index")

    if not ready:
        print("   No ready videos found. Check Stream uploads.")
        return 1

    # 2. Index each video
    success = 0
    failed = 0
    total_start = time.monotonic()

    for i, video in enumerate(ready):
        vid = video["id"]
        name = video.get("name", "Untitled")
        duration = video.get("duration", 0)

        print(f"\n  [{i+1}/{len(ready)}] {name} ({duration}s)")
        print(f"         id: {vid}")

        t0 = time.monotonic()
        result = index_video(vid, name, DEFAULT_ORG_ID)
        dt = time.monotonic() - t0

        status = result.get("status", result.get("error", "?"))
        chunks = result.get("chunks", 0)
        vectors = result.get("vectors", 0)
        print(f"         → {status} | {chunks} chunks, {vectors} vectors | {dt:.1f}s")

        if result.get("status") == "indexed":
            success += 1
        else:
            failed += 1
            print(f"         ⚠️  {json.dumps(result, indent=2)[:300]}")

    total_dt = time.monotonic() - total_start
    print(f"\n{'=' * 60}")
    print(f"  Done: {success} indexed, {failed} failed")
    print(f"  Total time: {total_dt:.1f}s")
    print(f"{'=' * 60}")
    print()
    print("  ✅ Now test the tutor:")
    print("     python3 scripts/test_tutor.py")
    print()
    print("  Or call directly:")
    print('     curl -X POST https://ai-tutor.yomi-alarape.workers.dev/tutor/ask \\')
    print('       -H "Content-Type: application/json" \\')
    print('       -H "Origin: https://learning.lumerax.co" \\')
    print(f'       -d \'{{"question":"What is this course about?","learner_id":"demo","lesson_id":"any","course_id":"any","org_id":"{DEFAULT_ORG_ID}"}}\'')
    print()

    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
