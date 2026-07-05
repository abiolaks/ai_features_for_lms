"""
pdf-extractor — Python Worker (Pyodide)
Extracts text from PDFs in R2, feeds to ai-indexing pipeline.
"""

from pyodide.http import pyfetch
from io import BytesIO
import PyPDF2
import json
import re


async def on_fetch(request, env):
    """Route requests to the appropriate handler."""
    url = request.url
    path = url.path if hasattr(url, 'path') else str(url).split("/", 3)[-1]
    if not path.startswith("/"):
        path = "/" + path.split("/", 1)[-1] if "/" in path else "/" + path

    if request.method == "POST" and path == "/extract":
        return await handle_extract(request, env)
    
    if request.method == "POST" and path == "/backfill":
        return await handle_backfill(request, env)
    
    if request.method == "GET" and path == "/health":
        return json_response({"status": "ok", "worker": "pdf-extractor"})
    
    return json_response({"error": "not_found"}, 404)


# ═══════════════════════════════════════════════════════════
#  POST /extract — single PDF
# ═══════════════════════════════════════════════════════════

async def handle_extract(request, env):
    """Extract text from a single PDF and feed to indexing."""
    try:
        body = await request.json()
    except:
        return json_response({"error": "invalid_json"}, 400)

    r2_key = body.get("r2Key")
    lesson_id = body.get("lesson_id")
    org_id = body.get("org_id")
    title = body.get("title", "Untitled")

    if not r2_key:
        return json_response({"error": "missing_field: r2Key"}, 400)
    if not lesson_id:
        return json_response({"error": "missing_field: lesson_id"}, 400)
    if not org_id:
        return json_response({"error": "missing_field: org_id"}, 400)

    # 1. Fetch PDF from R2
    try:
        pdf_obj = await env.LMS_CONTENT.get(r2_key)
        if pdf_obj is None:
            return json_response({"error": "file_not_found", "key": r2_key}, 404)
        
        pdf_bytes = await pdf_obj.bytes()
    except Exception as e:
        return json_response({"error": f"r2_fetch_failed: {str(e)}"}, 500)

    # 2. Extract text with PyPDF2
    try:
        reader = PyPDF2.PdfReader(BytesIO(pdf_bytes))
        pages = []
        for i, page in enumerate(reader.pages):
            text = page.extract_text()
            if text and text.strip():
                pages.append({
                    "number": i + 1,
                    "text": text.strip()
                })
        
        if not pages:
            return json_response({"error": "no_extractable_text", "key": r2_key}, 422)
        
        full_text = "\n\n".join(p["text"] for p in pages)
        print(f"[extract] {title}: {len(full_text)} chars, {len(pages)} pages")
    except Exception as e:
        return json_response({"error": f"pdf_parse_failed: {str(e)}"}, 500)

    # 3. Feed to ai-indexing pipeline
    indexing_url = getattr(env, "INDEXING_URL", "https://ai-indexing.yomi-alarape.workers.dev")
    webhook_secret = getattr(env, "WEBHOOK_SECRET", "")

    try:
        index_resp = await pyfetch(
            f"{indexing_url}/index",
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Webhook-Secret": webhook_secret,
            },
            body=json.dumps({
                "event": "publish",
                "org_id": org_id,
                "entity": {
                    "id": lesson_id,
                    "title": title,
                    "contentType": "pdf",
                    "content": full_text,
                    "durationSeconds": len(full_text),
                }
            })
        )
        index_result = await index_resp.json()
    except Exception as e:
        return json_response({
            "status": "extracted",
            "chars": len(full_text),
            "pages": len(pages),
            "indexing_error": str(e),
        })

    return json_response({
        "status": "extracted",
        "chars": len(full_text),
        "pages": len(pages),
        "indexing": index_result,
    })


# ═══════════════════════════════════════════════════════════
#  POST /backfill — all PDFs in R2
# ═══════════════════════════════════════════════════════════

async def handle_backfill(request, env):
    """Find all PDFs in R2 and extract each one."""
    try:
        body = await request.json()
    except:
        return json_response({"error": "invalid_json"}, 400)

    org_id = body.get("org_id")
    prefix = body.get("prefix", "")

    if not org_id:
        return json_response({"error": "missing_field: org_id"}, 400)

    # List PDFs in R2
    try:
        objects = await env.LMS_CONTENT.list({"prefix": prefix})
        pdf_keys = [
            obj.key for obj in objects.objects 
            if obj.key.lower().endswith(".pdf")
        ]
    except Exception as e:
        return json_response({"error": f"r2_list_failed: {str(e)}"}, 500)

    print(f"[backfill] found {len(pdf_keys)} PDFs with prefix '{prefix}'")

    # Extract and index each one
    results = []
    for key in pdf_keys:
        # Derive lesson_id from filename
        lesson_id = key.rsplit("/", 1)[-1].rsplit(".", 1)[0]
        lesson_id = re.sub(r"[^a-zA-Z0-9_-]", "_", lesson_id)
        
        # Derive title from filename
        title = lesson_id.replace("_", " ").replace("-", " ").title()

        try:
            pdf_obj = await env.LMS_CONTENT.get(key)
            if pdf_obj is None:
                results.append({"key": key, "error": "not_found"})
                continue

            pdf_bytes = await pdf_obj.bytes()
            reader = PyPDF2.PdfReader(BytesIO(pdf_bytes))
            pages = []
            for i, page in enumerate(reader.pages):
                text = page.extract_text()
                if text and text.strip():
                    pages.append({
                        "number": i + 1,
                        "text": text.strip()
                    })
            
            if not pages:
                results.append({"key": key, "error": "no_text"})
                continue

            full_text = "\n\n".join(p["text"] for p in pages)

            # Feed to indexing
            indexing_url = getattr(env, "INDEXING_URL", "https://ai-indexing.yomi-alarape.workers.dev")
            webhook_secret = getattr(env, "WEBHOOK_SECRET", "")

            await pyfetch(
                f"{indexing_url}/index",
                method="POST",
                headers={
                    "Content-Type": "application/json",
                    "X-Webhook-Secret": webhook_secret,
                },
                body=json.dumps({
                    "event": "publish",
                    "org_id": org_id,
                    "entity": {
                        "id": lesson_id,
                        "title": title,
                        "contentType": "pdf",
                        "content": full_text,
                        "durationSeconds": len(full_text),
                    }
                })
            )

            results.append({
                "key": key,
                "status": "queued",
                "chars": len(full_text),
                "pages": len(pages),
            })
            print(f"[backfill] indexed: {key} ({len(full_text)} chars)")

        except Exception as e:
            results.append({"key": key, "error": str(e)})
            print(f"[backfill] failed: {key} ({str(e)})")

    return json_response({
        "status": "complete",
        "found": len(pdf_keys),
        "results": results,
    })


# ═══════════════════════════════════════════════════════════
#  Helpers
# ═══════════════════════════════════════════════════════════

async def on_request(request, env):
    """Legacy entry point alias."""
    return await on_fetch(request, env)


def json_response(data, status=200):
    return Response.new(
        json.dumps(data),
        headers={"Content-Type": "application/json"},
        status=status,
    )
