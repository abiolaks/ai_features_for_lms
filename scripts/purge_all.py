#!/usr/bin/env python3
"""
Thorough purge of ALL old vectors (non-LMS UUID lesson_ids).
Uses multiple search queries to find and delete old vectors,
then re-indexes from the LMS export with proper metadata.

Usage:
  python3 scripts/purge_all.py \
    --org-id "7591945d-10ba-4a39-adde-a495c2c9449b" \
    --from-json lms-content-export.json
"""

import json, sys, time, urllib.request, argparse

TUTOR_URL = "https://ai-tutor.yomi-alarape.workers.dev/diag-search"
INDEXING_URL = "https://ai-indexing.yomi-alarape.workers.dev"

# Many different queries to surface different vectors
QUERIES = [
    "AI business innovation",
    "module lesson core lecture intro video",
    "SME adoption framework strategy",
    "foundations data machine learning deep",
    "decision intelligence workflow automation",
    "responsible ethical governance compliance",
    "the a in of and to it is for on with",
    "public speaking presentation communication",
    "innovation process digital transformation",
    "certificate assessment quiz completion",
]

def search_vectors():
    """Search with multiple queries and collect all old lesson_ids."""
    old_ids = set()
    
    for q in QUERIES:
        try:
            url = f"{TUTOR_URL}?q={urllib.request.quote(q)}"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode())
            
            for m in data.get("matches", []):
                lid = m["metadata"].get("lesson_id", "")
                if lid and not lid.startswith("019"):  # non-LMS UUID
                    old_ids.add(lid)
        except Exception as e:
            print(f"   ⚠️  Query '{q[:30]}' failed: {e}")
        time.sleep(0.5)
    
    return old_ids

def deindex_lesson(lesson_id):
    """Delete all vectors for a lesson."""
    url = f"{INDEXING_URL}/diag-deindex/{urllib.request.quote(lesson_id, safe='')}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode())

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--from-json", required=True, help="LMS export JSON for re-index")
    args = parser.parse_args()
    
    # Step 1: Find old vectors with multiple queries
    print("🔍 Searching for old vectors (10 queries)...")
    old_ids = search_vectors()
    print(f"   Found {len(old_ids)} old lesson IDs\n")
    
    if not old_ids:
        print("✅ No old vectors found!")
        return
    
    # Step 2: Delete them all
    deleted = 0
    failed = 0
    for i, lid in enumerate(sorted(old_ids)):
        try:
            result = deindex_lesson(lid)
            n = result.get("vectors_removed", 0)
            deleted += n
            status = "🗑" if n > 0 else "·"
            print(f"   [{i+1}/{len(old_ids)}] {status} {lid[:40]}... → {n} vectors")
        except Exception as e:
            failed += 1
            print(f"   [{i+1}/{len(old_ids)}] ⚠️  {lid[:40]}... → {e}")
        time.sleep(0.2)
    
    print(f"\n✅ Purged {deleted} vectors ({failed} errors)")
    
    # Step 3: Verify — search again to confirm cleanup
    print("\n🔍 Verifying cleanup...")
    remaining = search_vectors()
    if remaining:
        print(f"   ⚠️  {len(remaining)} old IDs still remain (may need another pass)")
        for lid in list(remaining)[:5]:
            print(f"      {lid[:50]}...")
    else:
        print("   ✅ All old vectors cleared!")
    
    # Step 4: Re-index from LMS export
    print(f"\n🔄 Re-indexing from {args.from_json}...")
    import subprocess
    subprocess.run([
        sys.executable, "scripts/backfill_all.py",
        "--org-id", "7591945d-10ba-4a39-adde-a495c2c9449b",
        "--from-json", args.from_json
    ])
    
    print("\n✅ Done!")

if __name__ == "__main__":
    main()
