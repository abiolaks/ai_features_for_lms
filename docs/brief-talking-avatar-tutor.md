# Brief: Talking Avatar for AI Tutor

**Date:** 2026-07-29
**Status:** Draft for review
**Initiative:** Extend AI04 Tutor with voice input/output + animated avatar

---

## Problem Statement

The AI tutor currently works well — it answers learner questions grounded in course content via text (HTTP and WebSocket streaming). Learners and stakeholders want to make the experience more engaging and natural by adding:

1. **Voice input** — learners speak questions instead of typing
2. **Voice output** — the tutor speaks answers aloud (TTS)
3. **Talking avatar** — a visual face/character that animates while speaking, creating a "talking head" conversational experience

The text responses should still appear alongside voice, and the core grounded Q&A pipeline (Vectorize → LLM → citations) should remain unchanged.

---

## Proposed Architecture

```
Learner (Browser)
  │
  ├─ 🎤 Mic → STT (Workers AI Whisper/Nova) ──→ Text
  │
  ├─ Text → AI04 Tutor (existing pipeline) ──→ Grounded Answer
  │      │
  │      ├─ Text → TTS (Deepgram Aura / Inworld) ──→ 🎵 Audio stream
  │      │
  │      └─ Text + Audio timestamps → Avatar animator ──→ 👤 Lip-sync animation
  │
  └─ Display: Text answer + citations + animated avatar
```

### Component Breakdown

| Layer | Technology | What It Does |
|-------|-----------|--------------|
| **Speech-to-Text** | `@cloudflare/voice` + `WorkersAIFluxSTT` | Browser mic → transcribed text → feeds into existing tutor pipeline |
| **AI Tutor** | Existing ai-tutor DO (unchanged) | Vectorize search → grounded prompt → LLM → answer text |
| **Text-to-Speech** | `@cloudflare/voice` + `WorkersAITTS` (`@cf/deepgram/aura-1`) or `inworld/tts-2` | Answer text → spoken audio streamed to browser |
| **Avatar Face** | Pruna P-Video-Avatar (`pruna/p-video-avatar`) on Workers AI | Generates talking-head video clip from portrait image + audio |
| **Voice Pipeline** | `@cloudflare/voice` Agents SDK | Orchestrates STT → LLM → TTS over WebSocket with Durable Objects for persistence |

---

## Options Assessment

### Option A: Voice-Only (Phase 1 Quick Win)

Add `@cloudflare/voice` to ai-tutor. No visual avatar.

```
Learner speaks → transcribed → same tutor pipeline → spoken back
```

| Pros | Cons |
|------|------|
| All within Cloudflare ecosystem | No visual avatar |
| Same DO, same Vectorize, same LLM | Audio-only experience |
| ~2-3 days to implement | |
| Uses existing Workers AI models (no extra cost) | |

**Tech stack:**
- `@cloudflare/voice` (`withVoice` mixin on existing TutorSession DO)
- `WorkersAIFluxSTT` — speech-to-text
- `WorkersAITTS` (`@cf/deepgram/aura-1`) — text-to-speech
- React `useVoiceAgent` hook on LMS frontend

---

### Option B: Voice + Pruna Avatar (Full Stack, Cloudflare-Native)

Voice pipeline from Option A + generate talking-head video per response.

```
Learner speaks → transcribed → LLM answer → TTS audio → 
  Pruna generates talking-head clip → browser plays video + audio
```

| Pros | Cons |
|------|------|
| Visual avatar face | Pruna generates video clips (not real-time streaming) |
| All within Cloudflare | ~3-5s generation latency per response |
| No third-party API costs | 720p/1080p video — higher bandwidth |
| Multiple voice options (30+ voices) | |

**Pruna P-Video-Avatar capabilities (`pruna/p-video-avatar` on Workers AI):**
- Input: portrait image + voice script or audio URL
- Output: talking-head video (720p or 1080p)
- 30+ voices across English, Spanish, French, German, Japanese, etc.
- Supports natural language steering: emotion, pace, style

**Architecture:**
```
Current:  Question → Text answer → Display
New:      Question → Text answer → TTS audio + Pruna video → Display avatar + audio
```

The text answer still appears (citations, etc.). The avatar clip plays alongside.

**Latency budget:**
| Step | Time |
|------|------|
| STT (Whisper/Nova on Workers AI) | ~500ms |
| Vectorize query + LLM (existing) | ~1-3s |
| TTS (Aura on Workers AI) | ~300ms |
| Pruna video generation | ~3-5s |
| **Total** | **~5-8s** |

---

### Option C: HeyGen Interactive Avatar (Third-Party, Most Polished)

Use HeyGen's real-time streaming avatar for a fully animated, professional talking head.

| Pros | Cons |
|------|------|
| Most polished visual experience | **$0.05/second** — expensive at scale |
| Real-time lip-sync (no generation delay) | Third-party dependency |
| Voice chat built-in (STT + TTS) | 3 concurrent session limit (self-serve) |
| Ready-made React SDK (`@heygen/liveavatar-web-sdk`) | Separate API + auth management |
| | Enterprise-only for API keys |

**Architecture:**
```
LMS Frontend → HeyGen SDK (avatar + voice chat)
                    │
                    ├─ STT → transcribed text
                    │
                    ├─ Our ai-tutor worker (grounded answer)
                    │
                    └─ Text answer → HeyGen TTS → avatar speaks
```

---

## Recommendation: Phased Approach

### Phase 1 — Voice Tutor (Week 1-2)

Add `@cloudflare/voice` to the existing ai-tutor Durable Object. No visual avatar. Learners speak and hear responses.

**What changes:**
- `TutorSession` DO gains `withVoice` mixin
- `onTurn()` calls existing `buildGroundedPrompt()` + LLM
- Response streams as both text (existing WebSocket) and TTS audio (new)
- LMS frontend adds `useVoiceAgent` React hook alongside existing text UI

**Deliverables:**
- Speaking/listening AI tutor on the lesson page
- Text fallback still works (type instead of speak)
- Conversation history persists across voice and text modes (same DO)

### Phase 2 — Visual Avatar (Week 3-4)

Add Pruna P-Video-Avatar for a talking face. Choose approach based on Phase 1 feedback:

**2a. Pruna (Cloudflare-native):** Generate short talking-head clips per answer
**2b. Lightweight 2D avatar:** Use a static illustration + browser-side lip-sync library (no generation delay, works offline)
**2c. HeyGen:** If budget approved, swap in HeyGen for real-time streaming avatar

---

## Integration Points with Existing System

| Existing Component | How It Changes |
|--------------------|----------------|
| `TutorSession` DO | Gains `withVoice` mixin — same DO, same SQLite, same history |
| `buildGroundedPrompt()` | **Unchanged** — still embeds question, queries Vectorize, builds prompt |
| LLM call via AI03 Gateway | **Unchanged** — still goes through ai-gateway service binding |
| Vectorize index | **Unchanged** — same content, same embeddings |
| WebSocket streaming endpoint | Augmented — now also streams audio frames alongside text tokens |
| HTTP `/tutor/ask` endpoint | **Unchanged** — text-only fallback still works |
| LMS Frontend | New voice UI components alongside existing text tutor widget |

---

## Open Questions

1. **Voice model choice:** Workers AI offers Deepgram Aura-1 and Inworld TTS-2. Inworld is more expressive (emotion, steering). Which is preferred?
2. **Avatar style:** Realistic human (Pruna/HeyGen) vs. stylized character (custom 2D)? Any brand guidelines?
3. **Latency tolerance:** Is 5-8s from question to avatar response acceptable, or is <2s required?
4. **Budget for HeyGen:** If the client wants the most polished experience, HeyGen is the answer but costs $0.05/sec (~$3/min per learner)
5. **Browser compatibility:** Voice input requires `getUserMedia` (mic permission). What's the fallback for learners without mics?
6. **Language support:** Current content is English. Are other languages planned?

---

## Next Steps

1. Review this brief — confirm Phase 1 scope and avatar preference
2. Spike: Prototype `@cloudflare/voice` with existing TutorSession DO (1 day)
3. Decision on avatar provider (Pruna vs. HeyGen vs. custom)
4. Implementation timeline

---

*Generated from research on Cloudflare Workers AI (Deepgram Aura/Inworld TTS, Pruna P-Video-Avatar), Cloudflare Voice Agents SDK, and HeyGen Interactive Avatar API.*
