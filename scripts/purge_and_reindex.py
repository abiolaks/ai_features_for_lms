#!/usr/bin/env python3
"""
Purge old vectors (non-LMS UUID lesson_ids) and re-index fresh.
Used after the LMS export backfill to clean up residual vectors
with empty course_id/module_id from previous indexing runs.

Usage:
  python3 scripts/purge_and_reindex.py \
    --org-id "7591945d-10ba-4a39-adde-a495c2c9449b" \
    --from-json lms-content-export.json
"""

import json, sys, time, urllib.request, argparse

TUTOR_URL = "https://ai-tutor.yomi-alarape.workers.dev/diag-search"
INDEXING_URL = "https://ai-indexing.yomi-alarape.workers.dev"

def get_old_vectors():
    """Find all vectors with non-LMS UUID lesson_ids."""
    req = urllib.request.Request(f"{TUTOR_URL}?q=a+the+in+of+and+is+it+to", 
        headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode())
    
    old_ids = set()
    for m in data.get("matches", []):
        lid = m["metadata"].get("lesson_id", "")
        if not lid.startswith("019"):  # LMS UUIDs start with 019
            old_ids.add(lid)
    return old_ids

def deindex_lesson(lesson_id):
    """Delete all vectors for a lesson."""
    url = f"{INDEXING_URL}/diag-deindex/{lesson_id}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--org-id", required=True)
    parser.add_argument("--from-json", required=True, help="LMS export JSON for re-index")
    args = parser.parse_args()
    
    # Step 1: Find and delete old vectors
    print("🔍 Finding old vectors (non-LMS UUIDs)...")
    old_ids = get_old_vectors()
    print(f"   Found {len(old_ids)} old lesson IDs to purge")
    
    deleted = 0
    for lid in old_ids:
        try:
            result = deindex_lesson(lid)
            n = result.get("vectors_removed", 0)
            deleted += n
            print(f"   🗑  {lid[:30]}... → {n} vectors removed")
        except Exception as e:
            print(f"   ⚠️  {lid[:30]}... → {e}")
        time.sleep(0.3)
    
    print(f"\n✅ Purged {deleted} old vectors")
    
    # Step 2: Re-index from LMS export
    print(f"\n🔄 Re-indexing from {args.from_json}...")
    import subprocess
    subprocess.run([
        sys.executable, "scripts/backfill_all.py",
        "--org-id", args.org_id,
        "--from-json", args.from_json
    ])
    
    print("\n✅ Done! Test with:")
    print(f"   python3 scripts/test_tutor.py")

if __name__ == "__main__":
    main()
