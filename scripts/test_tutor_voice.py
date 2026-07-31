#!/usr/bin/env python3
"""
AI Tutor — Voice STT WebSocket Test
Records from microphone → base64 WAV → sends ask_voice → streams response.
Requires: pip install websockets pyaudio

Run: python3 scripts/test_tutor_voice.py
Environment: WS_BASE env var or defaults to deployed worker URL.
"""

import asyncio
import json
import sys
import os
import base64
import io
import wave

WS_BASE = os.environ.get(
    "WS_BASE",
    "wss://ai-tutor.yomi-alarape.workers.dev/tutor/ws"
)

# Real LMS org — content is indexed under this UUID, not "dev-org"
DEFAULT_ORG_ID = "7591945d-10ba-4a39-adde-a495c2c9449b"
DEFAULT_LESSON_ID = "019f1205-fd9b-726a-b29f-0e1f7d866a88"  # AI Assistants lesson
DEFAULT_COURSE_ID = "019f0513-90ba-7170-bf05-8011a0e3f028"

try:
    import websockets
except ImportError:
    import subprocess
    subprocess.run([sys.executable, "-m", "pip", "install", "websockets", "-q"])
    import websockets


# ── Audio helpers ──

def record_audio(duration_sec: float = 4.0, sample_rate: int = 16000) -> str:
    """Record from mic → return base64-encoded WAV (16kHz, mono, 16-bit)."""
    try:
        import pyaudio
    except ImportError:
        raise SystemExit("Install pyaudio: pip install pyaudio")

    p = pyaudio.PyAudio()
    stream = p.open(
        format=pyaudio.paInt16,
        channels=1,
        rate=sample_rate,
        input=True,
        frames_per_buffer=1024,
    )

    print(f"🎤 Recording for {duration_sec}s... (speak now)")
    frames = []
    for _ in range(0, int(sample_rate / 1024 * duration_sec)):
        data = stream.read(1024, exception_on_overflow=False)
        frames.append(data)

    stream.stop_stream()
    stream.close()
    p.terminate()

    # Write WAV to memory
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(sample_rate)
        wf.writeframes(b"".join(frames))

    wav_bytes = buffer.getvalue()
    b64 = base64.b64encode(wav_bytes).decode("ascii")
    print(f"   recorded {len(wav_bytes)} bytes → {len(b64)} base64 chars\n")
    return b64


def build_silent_audio(ms: int = 500) -> str:
    """Generate silent WAV for quick smoke test (no mic needed)."""
    sample_rate = 16000
    num_samples = int(sample_rate * ms / 1000)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b"\x00\x00" * num_samples)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


# ── WebSocket voice test ──

async def voice_ask(
    audio_b64: str,
    lesson_id: str = DEFAULT_LESSON_ID,
    course_id: str = DEFAULT_COURSE_ID,
    org_id: str = DEFAULT_ORG_ID,
    learner_id: str = "voice-demo-1",
):
    url = f"{WS_BASE}?learner_id={learner_id}"
    print(f"  Connecting: {url}")
    print(f"  Lesson: {lesson_id}")

    async with websockets.connect(url) as ws:
        # 1. Read mode + persona message (sent on connect)
        mode_msg = json.loads(await ws.recv())
        if mode_msg["type"] == "mode":
            print(f"  Mode: {mode_msg['active_mode']} | Persona: {mode_msg['persona']['name']}")
        else:
            print(f"  First msg: {mode_msg['type']}")

        # 2. Send ask_voice
        print(f"  Sending ask_voice ({len(audio_b64)} chars audio)...")
        await ws.send(json.dumps({
            "type": "ask_voice",
            "audio": audio_b64,
            "lesson_id": lesson_id,
            "course_id": course_id,
            "org_id": org_id,
        }))

        # 3. Stream response
        print()
        print("-" * 60)
        transcript = ""
        answer = ""
        citation_count = 0
        audio_chunks: list[bytes] = []

        while True:
            msg = await ws.recv()
            data = json.loads(msg)
            t = data["type"]

            if t == "transcript":
                transcript = data["text"]
                print(f"📝 Transcript: \"{transcript}\"")

            elif t == "corrected":
                print(f"✨ Corrected: \"{data['text']}\"")

            elif t == "citations":
                citation_count = len(data["citations"])
                sources = [c["lesson_title"] for c in data["citations"][:3]]
                print(f"📚 Sources: {', '.join(sources)}")
                print("-" * 60)
                print("  A: ", end="", flush=True)

            elif t == "token":
                print(data["text"], end="", flush=True)
                answer += str(data["text"])

            elif t == "audio":
                chunk_bytes = base64.b64decode(data["data"])
                audio_chunks.append(chunk_bytes)
                print(f"\n  🔊 audio chunk {data.get('chunk_index','?')} ({len(chunk_bytes)} bytes)", end="")

            elif t == "tts_done":
                audio_bytes = b"".join(audio_chunks)
                print(f"\n  ✅ TTS complete ({len(audio_bytes)} bytes, {len(audio_chunks)} chunks)")
                return transcript, answer, audio_bytes

            elif t == "tts_error":
                print(f"\n  ⚠️ TTS error: {data['error']}")
                return transcript, answer, b""

            elif t == "done":
                print()
                print("-" * 60)
                print(f"  ✅ Done | citations: {citation_count} | history: {data.get('history_length', '?')}")
                # Don't return yet — TTS audio chunks come after done
                answer = data.get('answer', answer)

            elif t == "error":
                print(f"\n  ❌ ERROR: {data['error']}")
                audio_bytes = b"".join(audio_chunks)
                return transcript, answer, audio_bytes


async def main():
    print("=" * 60)
    print("  AI Tutor — Voice STT Test")
    print("=" * 60)
    print()

    mode = sys.argv[1] if len(sys.argv) > 1 else "silent"

    if mode == "mic":
        audio = record_audio(duration_sec=4.0)
    elif mode == "silent":
        print("  🔇 Silent audio smoke test (no mic needed)")
        print("     → STT should fail gracefully (no speech in silent audio)")
        audio = build_silent_audio(ms=500)
    elif mode == "empty":
        print("  🚫 Empty audio test → should return error")
        audio = ""
    else:
        # Assume it's a WAV file path
        with open(mode, "rb") as f:
            audio = base64.b64encode(f.read()).decode("ascii")
        print(f"  📁 Loaded WAV from: {mode}")

    transcript, answer, audio_bytes = await voice_ask(audio_b64=audio)

    print()
    print("=" * 60)
    if transcript:
        print(f"  ✅ Voice pipeline works:")
        print(f"     Speech → \"{transcript}\" → answer ({len(answer)} chars)")
    else:
        print(f"  ⚠️  No transcript (silent audio = expected failure)")

    if audio_bytes:
        import tempfile, subprocess
        wav_path = os.path.join(tempfile.gettempdir(), "tutor_voice_output.wav")
        with open(wav_path, "wb") as f:
            f.write(audio_bytes)
        print(f"  🔊 Audio saved: {wav_path} ({len(audio_bytes)} bytes)")
        print(f"  🔈 Playing...")
        # Try ffplay first (handles WAV better), fall back to afplay
        if os.system(f"which ffplay > /dev/null 2>&1") == 0:
            subprocess.run(["ffplay", "-nodisp", "-autoexit", wav_path],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            # Convert to m4a for afplay
            m4a_path = wav_path.replace(".wav", ".m4a")
            subprocess.run(["ffmpeg", "-y", "-i", wav_path, "-c:a", "aac", "-b:a", "128k", m4a_path],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if os.path.exists(m4a_path):
                os.system(f"afplay {m4a_path}")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
