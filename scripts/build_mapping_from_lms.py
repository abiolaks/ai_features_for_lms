#!/usr/bin/env python3
"""
Build Content Mapping from LMS API
====================================
Calls the LMS API to walk courses → modules → lessons and generate
the JSON needed for backfill_all.py --from-json.

This script should be run from the LMS environment where you have
API access (internal key, JWT token, etc.). It queries the LMS for
all published courses/modules/lessons and outputs a content map.

Usage:
  # With API key auth (internal):
  python3 scripts/build_mapping_from_lms.py \
    --lms-url "https://lms-staging-api-xxx.azurewebsites.net" \
    --api-key "your-internal-key"

  # Output to file for backfill:
  python3 scripts/build_mapping_from_lms.py \
    --lms-url "..." --api-key "..." \
    --output lms-content-export.json

  # Then backfill:
  python3 scripts/backfill_all.py --org-id "..." --from-json lms-content-export.json

Requirements: Python 3.8+ (stdlib only)
"""

import json
import sys
import urllib.request
import urllib.error
import argparse
import time

# ═══════════════════════════════════════════════════════
#  Helpers
# ═══════════════════════════════════════════════════════

def api_get(base_url: str, path: str, auth_token: str = None, api_key: str = None) -> dict:
    """GET from LMS API with Bearer token or API key auth."""
    headers = {"Accept": "application/json", "User-Agent": "LMS-Mapping-Builder/1.0"}
    if auth_token:
        headers["Authorization"] = f"Bearer {auth_token}"
    elif api_key:
        headers["X-API-Key"] = api_key
    
    url = f"{base_url}{path}"
    req = urllib.request.Request(url, headers=headers)
    
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:200] if e.fp else ""
        print(f"  ⚠️  {e.code} on {path}: {body}", file=sys.stderr)
        return {}
    except Exception as e:
        print(f"  ⚠️  Error on {path}: {e}", file=sys.stderr)
        return {}


def get_all_pages(base_url: str, path: str, auth_token: str = None, api_key: str = None) -> list:
    """Fetch all pages from a paginated LMS endpoint."""
    page = 1
    all_items = []
    while True:
        sep = "&" if "?" in path else "?"
        paged_path = f"{path}{sep}page={page}&per_page=50"
        resp = api_get(base_url, paged_path, auth_token, api_key)
        
        # Handle different response shapes
        data = resp.get("data", resp)
        if isinstance(data, dict):
            items = data.get("data", data.get("courses", data.get("modules", [])))
            meta = data.get("meta", {})
            total_pages = meta.get("last_page", 1)
        elif isinstance(data, list):
            items = data
            total_pages = 1
        else:
            items = []
            total_pages = 1
        
        if not items:
            break
        
        all_items.extend(items)
        
        if page >= total_pages:
            break
        page += 1
        time.sleep(0.2)  # rate limit
    
    return all_items


# ═══════════════════════════════════════════════════════
#  Main
# ═══════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="Build content mapping from LMS API")
    parser.add_argument("--lms-url", required=True, help="LMS API base URL")
    parser.add_argument("--bearer-token", help="Authorization: Bearer token (or set LMS_BEARER_TOKEN env var)")
    parser.add_argument("--api-key", help="X-API-Key for internal service auth (alternative)")
    parser.add_argument("--output", "-o", help="Output JSON file (default: stdout)")
    parser.add_argument("--org-id", help="Filter by organization ID (optional)")
    args = parser.parse_args()
    
    base_url = args.lms_url.rstrip("/")
    auth_token = args.bearer_token or __import__("os").environ.get("LMS_BEARER_TOKEN")
    api_key = args.api_key
    
    if not auth_token and not api_key:
        print("⚠️  No auth provided. Trying public endpoints...", file=sys.stderr)
    
    content_list = []
    
    print(f"🔍 Fetching courses from {base_url}...", file=sys.stderr)
    
    # Step 1: Get all courses
    courses = get_all_pages(base_url, "/api/v1/courses", auth_token, api_key)
    if not courses:
        print("  No courses from /api/v1/courses, trying /api/v1/public/courses...", file=sys.stderr)
        courses = get_all_pages(base_url, "/api/v1/public/courses", auth_token, api_key)
    
    if not courses:
        print("❌ No courses found. Check your API access.", file=sys.stderr)
        return 1
    
    # Filter by org if specified
    if args.org_id:
        courses = [c for c in courses if c.get("organizationId") == args.org_id]
    
    print(f"  Found {len(courses)} courses", file=sys.stderr)
    
    # Step 2: For each course, get modules and lessons
    for course in courses:
        course_id = course.get("id", "")
        course_title = course.get("title", "Untitled")
        org_id = course.get("organizationId", "")
        
        print(f"  📚 {course_title[:60]}", file=sys.stderr)
        
        modules = get_all_pages(base_url, f"/api/v1/courses/{course_id}/modules", auth_token, api_key)
        
        if not modules:
            print(f"     ⚠️  No modules found (may need auth)", file=sys.stderr)
            continue
        
        print(f"     {len(modules)} modules", file=sys.stderr)
        
        for module in modules:
            module_id = module.get("id", "")
            module_title = module.get("title", "Untitled")
            
            lessons = get_all_pages(base_url, f"/api/v1/modules/{module_id}/lessons", auth_token, api_key)
            
            print(f"     📖 {module_title[:50]} — {len(lessons)} lessons", file=sys.stderr)
            
            for lesson in lessons:
                lesson_id = lesson.get("id", "")
                lesson_title = lesson.get("title", "Untitled")
                content_type = lesson.get("contentType", "unknown")
                video_id = lesson.get("cloudflareVideoId", "")
                storage = lesson.get("storageProvider", "")
                content_url = lesson.get("contentUrl", "")
                
                entry = {
                    "id": lesson_id,
                    "title": lesson_title,
                    "contentType": content_type,
                    "course_id": course_id,
                    "module_id": module_id,
                }
                
                if content_type == "video" and video_id:
                    entry["cloudflareVideoId"] = video_id
                elif content_type in ("document", "presentation", "pdf"):
                    entry["contentType"] = "pdf"
                    # Store the original URL — we'll resolve to R2 keys later
                    if content_url:
                        # Extract just the filename from URLs like:
                        # Azure: .../module-1-lesson-2-intro-video.pdf?X-Amz-...
                        # R2: content/document/2026/.../module-1-lesson-2-intro-video.pdf
                        filename = content_url.split("?")[0].split("/")[-1]
                        entry["_source_url"] = content_url
                        entry["_filename"] = filename
                    else:
                        print(f"       ⚠️  {lesson_title[:40]} — no content URL", file=sys.stderr)
                
                content_list.append(entry)
    
    # Step 3: Resolve Azure URLs to R2 keys by matching filenames
    print(f"\n🔍 Resolving R2 keys for {sum(1 for e in content_list if '_filename' in e)} PDFs...", file=sys.stderr)
    
    # Fetch R2 file list
    r2_map = {}
    try:
        r2_url = "https://ai-indexing.yomi-alarape.workers.dev/r2-list?limit=200"
        r2_req = urllib.request.Request(r2_url, headers={"User-Agent": "LMS-Mapping-Builder/1.0"})
        with urllib.request.urlopen(r2_req, timeout=30) as resp:
            r2_data = json.loads(resp.read().decode())
            for obj in r2_data.get("objects", []):
                key = obj.get("key", "")
                filename = key.split("/")[-1].split("?")[0].lower()
                if filename.endswith(".pdf"):
                    r2_map[filename] = key
        print(f"   Found {len(r2_map)} PDFs in R2", file=sys.stderr)
    except Exception as e:
        print(f"   ⚠️  Could not fetch R2 list: {e}", file=sys.stderr)
    
    resolved = 0
    for entry in content_list:
        filename = entry.pop("_filename", None)
        entry.pop("_source_url", None)
        if filename and filename.lower() in r2_map:
            entry["r2Key"] = r2_map[filename.lower()]
            resolved += 1
        elif filename:
            # Try partial match (module-X-lesson-Y pattern)
            filename_lower = filename.lower()
            for r2_name, r2_key in r2_map.items():
                if filename_lower in r2_name or r2_name in filename_lower:
                    entry["r2Key"] = r2_key
                    resolved += 1
                    break
    
    print(f"   Resolved {resolved} PDFs to R2 keys", file=sys.stderr)
    
    # Step 4: Filter out entries with no indexable content
    filtered = []
    for entry in content_list:
        if entry.get("cloudflareVideoId") or entry.get("r2Key"):
            filtered.append(entry)
    skipped = len(content_list) - len(filtered)
    if skipped:
        print(f"   Skipped {skipped} lessons with no indexable content (no video ID or R2 key)", file=sys.stderr)
    content_list = filtered
    output = {"content": content_list}
    
    if args.output:
        with open(args.output, "w") as f:
            json.dump(output, f, indent=2)
        print(f"\n✅ Wrote {len(content_list)} lessons to {args.output}", file=sys.stderr)
        print(f"\n📋 Run the backfill:", file=sys.stderr)
        org_id_arg = args.org_id or courses[0].get("organizationId", "YOUR-ORG-ID")
        print(f"   python3 scripts/backfill_all.py --org-id \"{org_id_arg}\" --from-json {args.output}", file=sys.stderr)
    else:
        print(json.dumps(output, indent=2))
    
    return 0


if __name__ == "__main__":
    sys.exit(main())
