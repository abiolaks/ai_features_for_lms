#!/usr/bin/env python3
"""
Content Backfill — Videos + PDFs/PPTs
======================================
Indexes course content into Vectorize for AI tutor grounding.

⚠️  IMPORTANT — Multi-Org: This script indexes ALL content in Stream/R2
under a single org_id. It is designed for seeding the FIRST org or for
environments with only one org. For subsequent orgs, use --from-json
with a content list exported by the LMS (which knows org ownership).

Usage:
  # Single-org mode (indexes everything in Stream + R2):
  python3 scripts/backfill_all.py --org-id "ORG-UUID"

  # Multi-org mode (index only specific content for a new org):
  python3 scripts/backfill_all.py --org-id "ORG-UUID" --from-json lms-export.json

  # Dry run to preview:
  python3 scripts/backfill_all.py --org-id "ORG-UUID" --dry-run
"""

import json
import sys
import time
import urllib.request
import urllib.parse
import argparse
import re
from pathlib import Path

# ═══════════════════════════════════════════════════════
#  Config
# ═══════════════════════════════════════════════════════

INDEXING_BASE = "https://ai-indexing.yomi-alarape.workers.dev"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
}

DEFAULT_ORG_ID = "dev-org"

# R2 key patterns to skip (non-course content)
SKIP_PDF_PATTERNS = [
    re.compile(r"analysis\.pdf$", re.I),
    re.compile(r"policydocuments", re.I),
    re.compile(r"verdict\.pdf$", re.I),
    re.compile(r"codeofconduct\.pdf$", re.I),
    re.compile(r"vercel-wix", re.I),
    re.compile(r"wbs-doc-pmo", re.I),
    re.compile(r"wragby-vmo", re.I),
    re.compile(r"29176cdf", re.I),  # UUID-named duplicates
]

# ═══════════════════════════════════════════════════════
#  Helpers
# ═══════════════════════════════════════════════════════

def get_json(url: str) -> dict:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def index_video(video_id: str, title: str, org_id: str) -> dict:
    """Call GET /diag-index/:videoId/:title?org_id=... to index a single video."""
    safe_title = urllib.request.quote(title, safe="")
    url = f"{INDEXING_BASE}/diag-index/{video_id}/{safe_title}?org_id={urllib.request.quote(org_id)}"
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        return {"error": str(e)}


def index_pdf(r2_key: str, title: str, lesson_id: str, org_id: str) -> dict:
    """Call GET /diag-extract?key=...&title=...&lesson_id=...&org_id=..."""
    params = urllib.parse.urlencode({
        "key": r2_key,
        "title": title,
        "lesson_id": lesson_id,
        "org_id": org_id,
    })
    url = f"{INDEXING_BASE}/diag-extract?{params}"
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        return {"error": str(e)}


def derive_lesson_id_from_key(key: str) -> str:
    """Extract a clean lesson_id from an R2 key."""
    filename = key.split("/")[-1]
    return re.sub(r'\.(pdf|pptx|ppt|txt|md)$', '', filename, flags=re.I)


def derive_title_from_key(key: str) -> str:
    """Derive a human-readable title from an R2 key."""
    raw = derive_lesson_id_from_key(key)
    return raw.replace("-", " ").title()


def should_skip_pdf(key: str) -> bool:
    """Check if this PDF should be skipped (non-course content)."""
    for pattern in SKIP_PDF_PATTERNS:
        if pattern.search(key):
            return True
    return False


# ═══════════════════════════════════════════════════════
#  Content discovery modes
# ═══════════════════════════════════════════════════════

def discover_all_from_stream_and_r2():
    """Discover ALL content from Stream and R2 (single-org mode)."""
    # Videos
    videos = []
    try:
        data = get_json(f"{INDEXING_BASE}/videos")
        for v in data.get("videos", []):
            if v.get("status") == "ready":
                videos.append({
                    "video_id": v["id"],
                    "title": v.get("name", "Untitled"),
                    "duration": v.get("duration", 0),
                })
    except Exception as e:
        print(f"  ⚠️  Failed to fetch videos: {e}")

    # PDFs
    pdfs = []
    try:
        data = get_json(f"{INDEXING_BASE}/r2-list?limit=100")
        for obj in data.get("objects", []):
            key = obj.get("key", "")
            if key.endswith((".pdf", ".pptx", ".ppt")):
                if not should_skip_pdf(key):
                    pdfs.append({
                        "r2_key": key,
                        "title": derive_title_from_key(key),
                        "lesson_id": derive_lesson_id_from_key(key),
                        "size": obj.get("size", 0),
                    })
    except Exception as e:
        print(f"  ⚠️  Failed to fetch R2 list: {e}")

    return videos, pdfs


def discover_from_json(json_path: str):
    """Discover content from an LMS-exported JSON file (multi-org mode)."""
    with open(json_path) as f:
        data = json.load(f)

    videos = []
    pdfs = []

    for item in data.get("content", data if isinstance(data, list) else []):
        content_type = item.get("contentType", item.get("type", "")).lower()

        if content_type == "video":
            videos.append({
                "video_id": item.get("cloudflareVideoId", item.get("video_id", "")),
                "title": item.get("title", "Untitled"),
                "duration": item.get("durationSeconds", item.get("duration", 0)),
            })
        elif content_type in ("pdf", "ppt", "pptx", "document"):
            pdfs.append({
                "r2_key": item.get("r2Key", item.get("r2_key", "")),
                "title": item.get("title", "Untitled"),
                "lesson_id": item.get("id", item.get("lesson_id", "")),
                "size": item.get("size", 0),
            })

    return videos, pdfs


# ═══════════════════════════════════════════════════════
#  Main
# ═══════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(
        description="Backfill content into Vectorize for AI tutor grounding",
        epilog="""
Examples:
  # Single-org (first org, or only org):
  python3 scripts/backfill_all.py --org-id "7591945d-10ba-4a39-adde-a495c2c9449b"

  # Multi-org (new org joining — LMS exports their content first):
  python3 scripts/backfill_all.py --org-id "NEW-ORG-UUID" --from-json org-b-content.json

The --from-json file should be exported by the LMS and contain only that org's content:
{
  "content": [
    {
      "id": "lesson-uuid",
      "title": "Module 1 Lesson 1",
      "contentType": "video",
      "cloudflareVideoId": "abc123",
      "durationSeconds": 300
    },
    {
      "id": "lesson-uuid-2",
      "title": "Module 1 Slides",
      "contentType": "pdf",
      "r2Key": "content/document/2026/.../slides.pdf"
    }
  ]
}
        """,
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--org-id", default=DEFAULT_ORG_ID, help=f"Org ID to index under (default: {DEFAULT_ORG_ID})")
    parser.add_argument("--from-json", metavar="FILE", help="LMS-exported JSON file listing content for this org (multi-org mode)")
    parser.add_argument("--skip-videos", action="store_true", help="Skip video indexing")
    parser.add_argument("--skip-pdfs", action="store_true", help="Skip PDF/PPT indexing")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be indexed without doing it")
    args = parser.parse_args()

    org_id = args.org_id

    # ── Content discovery ──
    if args.from_json:
        print(f"📄 Reading content list from: {args.from_json}")
        videos, pdfs = discover_from_json(args.from_json)
        discovery_mode = f"LMS export ({args.from_json})"
    else:
        videos, pdfs = discover_all_from_stream_and_r2()
        discovery_mode = "Stream + R2 (ALL content)"

    print("=" * 70)
    print(f"  Content Backfill")
    print(f"  Org ID:     {org_id}")
    print(f"  Source:     {discovery_mode}")
    print(f"  Videos:     {len(videos)}")
    print(f"  PDFs:       {len(pdfs)}")
    if not args.from_json:
        print(f"  ⚠️  Single-org mode — indexes ALL content under this org_id")
        print(f"  ⚠️  For multi-org, use --from-json with LMS-exported content list")
    if args.dry_run:
        print("  *** DRY RUN — nothing will be indexed ***")
    print("=" * 70)

    total_success = 0
    total_failed = 0

    # ═══════════════════════════════════════════════════
    #  Phase 1: Videos
    # ═══════════════════════════════════════════════════
    if not args.skip_videos and videos:
        print("\n─── Phase 1: Videos ───")
        video_success = 0
        video_failed = 0
        total_start = time.monotonic()

        for i, video in enumerate(videos):
            vid = video["video_id"]
            title = video["title"]
            duration = video.get("duration", 0)
            status = f"[{i+1}/{len(videos)}]"

            if args.dry_run:
                print(f"  {status} WOULD INDEX: {title} ({duration:.0f}s) id={vid[:16]}...")
                video_success += 1
                continue

            print(f"  {status} {title} ({duration:.0f}s) id={vid[:16]}...", end=" ", flush=True)
            t0 = time.monotonic()
            result = index_video(vid, title, org_id)
            dt = time.monotonic() - t0

            status_result = result.get("status", result.get("error", "?"))
            chunks = result.get("chunks", 0)
            if status_result == "indexed":
                video_success += 1
                print(f"✅ {chunks} chunks | {dt:.1f}s")
            else:
                video_failed += 1
                print(f"❌ {status_result} | {dt:.1f}s")
                print(f"       {json.dumps(result, indent=None)[:200]}")

        total_success += video_success
        total_failed += video_failed
        dt = time.monotonic() - total_start
        print(f"  Video result: {video_success} indexed, {video_failed} failed ({dt:.1f}s)")

    # ═══════════════════════════════════════════════════
    #  Phase 2: PDFs
    # ═══════════════════════════════════════════════════
    if not args.skip_pdfs and pdfs:
        print("\n─── Phase 2: PDFs ───")
        pdf_success = 0
        pdf_failed = 0
        total_start = time.monotonic()

        for i, pdf in enumerate(pdfs):
            r2_key = pdf["r2_key"]
            filename = r2_key.split("/")[-1]
            title = pdf["title"]
            lesson_id = pdf["lesson_id"]
            size_kb = pdf.get("size", 0) / 1024
            status = f"[{i+1}/{len(pdfs)}]"

            if args.dry_run:
                print(f"  {status} WOULD INDEX: {filename} ({size_kb:.0f}KB) → lesson_id={lesson_id}")
                pdf_success += 1
                continue

            print(f"  {status} {filename} ({size_kb:.0f}KB) → \"{title}\"", end=" ", flush=True)
            t0 = time.monotonic()
            result = index_pdf(r2_key, title, lesson_id, org_id)
            dt = time.monotonic() - t0

            status_result = result.get("status", result.get("error", "?"))
            chars = result.get("chars", 0)
            if status_result in ("queued", "indexed"):
                pdf_success += 1
                print(f"✅ {chars} chars | {dt:.1f}s")
            else:
                pdf_failed += 1
                print(f"❌ {status_result} | {dt:.1f}s")
                print(f"       {json.dumps(result, indent=None)[:200]}")

        total_success += pdf_success
        total_failed += pdf_failed
        dt = time.monotonic() - total_start
        print(f"  PDF result: {pdf_success} indexed, {pdf_failed} failed ({dt:.1f}s)")

    # ═══════════════════════════════════════════════════
    #  Summary
    # ═══════════════════════════════════════════════════
    print()
    print("=" * 70)
    print(f"  Backfill Complete: {total_success} succeeded, {total_failed} failed")
    print("=" * 70)
    print()
    if args.dry_run:
        print("  Run without --dry-run to actually index.")
    else:
        print("  Verify:")
        print(f'    curl "https://ai-tutor.yomi-alarape.workers.dev/diag-search?q=test"')
        print(f"  The tutor queries with org_id={org_id} to find this content.")
    print()

    return 0 if total_failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
