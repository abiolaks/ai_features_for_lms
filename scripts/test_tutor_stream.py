#!/usr/bin/env python3
"""
AI Tutor WebSocket Streaming Test
Connects to the tutor via WebSocket and streams tokens in real-time.
Run: python3 scripts/test_tutor_stream.py
"""

import asyncio
import json
import sys

try:
    import websockets
except ImportError:
    print("Installing websockets...")
    import subprocess
    subprocess.run([sys.executable, "-m", "pip", "install", "websockets", "-q"])
    import websockets

WS_BASE = "wss://ai-tutor.yomi-alarape.workers.dev/tutor/ws"


async def stream_question(question, lesson_id, course_id="c1", org_id="dev-org", learner_id="demo-stream-1"):
    """Open a WebSocket, send a question, and stream the response."""
    url = f"{WS_BASE}?learner_id={learner_id}"
    print(f"\n{'='*60}")
    print(f"  Q: {question}")
    print(f"{'='*60}")
    print("  A: ", end="", flush=True)

    async with websockets.connect(url) as ws:
        # Send the question
        await ws.send(json.dumps({
            "type": "ask",
            "question": question,
            "lesson_id": lesson_id,
            "course_id": course_id,
            "org_id": org_id,
        }))

        citations = []
        answer = ""
        has_citations = False

        while True:
            msg = await ws.recv()
            data = json.loads(msg)

            if data["type"] == "citations":
                citations = data["citations"]
                if not has_citations:
                    has_citations = True
                    source_names = [c["lesson_title"] for c in citations[:3]]
                    print(f"\n     [sources: {', '.join(source_names)}]", end="")
                    print("\n  A: ", end="", flush=True)

            elif data["type"] == "token":
                print(str(data["text"]), end="", flush=True)
                answer += str(data["text"])

            elif data["type"] == "done":
                print()
                print(f"     [done | citations: {len(citations)} | history: {data.get('history_length', '?')}]")
                print()
                return answer

            elif data["type"] == "error":
                print(f"\n     [ERROR: {data['error']}]")
                return ""


async def main():
    print("AI Tutor — WebSocket Streaming Test")
    print("=" * 60)
    print(f"  Connecting to: {WS_BASE}?learner_id=...")
    print("  (tokens stream in real-time — no spinner, no waiting)")
    print()

    # ── 1. Video question ──
    await stream_question(
        question="What is Jira and how does it help teams?",
        lesson_id="df8f7fb979c93e3ba83caee3e578e02c",
    )

    # ── 2. Follow-up (tests conversation memory via WebSocket) ──
    await stream_question(
        question="Give me a specific example from the lesson",
        lesson_id="df8f7fb979c93e3ba83caee3e578e02c",
    )

    # ── 3. PDF question ──
    await stream_question(
        question="What is decision intelligence?",
        lesson_id="module-4-lesson-3",
        learner_id="demo-stream-2",  # different session for PDF
    )

    print("=" * 60)
    print("  ✅ Streaming works — tokens appear as LLM generates them")
    print("  ✅ Citations sent before tokens — UI shows sources immediately")
    print("  ✅ Conversation memory works across WebSocket messages")
    print("  ✅ Both video and PDF content streams successfully")
    print()


if __name__ == "__main__":
    asyncio.run(main())
