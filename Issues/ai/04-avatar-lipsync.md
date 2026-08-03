# 04 — Avatar Lip-Sync: persona voices with viseme-driven animation

## Problem Statement

The current ai-tutor delivers text answers with optional TTS audio via Cloudflare melotts. Learners hear a voice but see no visual avatar. The LMS platform needs an AI tutor avatar that **speaks with synchronized mouth movement** while delivering grounded course answers, with learners able to **choose from a catalog of characters and voices**.

Melotts provides raw WAV audio with no phoneme, word, or viseme timing data — making lip-sync animation impossible. Azure Speech SDK emits `VisemeReceived` events with standardized mouth shape IDs and millisecond offsets, enabling browser-side canvas animation of any character portrait.

## Solution

The ai-tutor Worker continues generating grounded answers as today. The WebSocket protocol extends with a `persona` message carrying the learner's chosen character and Azure voice ID. The browser (LMS frontend) connects to Azure Speech SDK directly for TTS — receiving both WAV audio and a viseme timeline. A canvas-based avatar component renders the character portrait with mouth shapes driven by the viseme stream, synchronized to playback via `AudioContext`.

The Worker never touches Azure Speech — it delivers text and persona configuration. The browser handles all rendering and audio. This keeps the Worker fast, stateless, and Cloudflare-native while the browser owns the real-time animation pipeline.

## User Stories

1. As a learner, I want to see an AI tutor character on screen, so that the interaction feels personal and engaging.
2. As a learner, I want the character's mouth to move in sync with the spoken answer, so that it looks natural and human-like.
3. As a learner, I want to choose from multiple tutor characters (Aura, Marcus, Jenny, etc.), so that I can pick one I connect with.
4. As a learner, I want to hear the answer spoken in a natural voice matching the character I chose, so that it feels like a real conversation.
5. As a learner, I want the text answer to appear alongside the avatar, so that I can read while listening or when audio is unavailable.
6. As a learner, I want the avatar to work regardless of whether I asked via text or voice, so that the experience is consistent.
7. As an LMS admin, I want to configure which Azure voices and characters are available to learners, so that I can align with the course brand and audience.
8. As an LMS admin, I want to upload custom character portraits without code changes, so that the avatar matches our brand identity.
9. As a developer, I want the avatar to degrade gracefully — text always shows, audio/viseme are enhancements — so that learners never lose the answer.
10. As a learner on a slow connection, I want the text answer to appear immediately while the audio loads, so that I'm not waiting for speech to start reading.

## Implementation Decisions

### Architecture: Browser-side TTS, Worker-side text

Azure Speech SDK runs in the browser, not the Worker. This is deliberate:
- Viseme events are SDK-only (not available via REST API)
- Browser-side eliminates Worker→Azure→Worker→Browser round-trip latency
- Worker stays Cloudflare-native, no Azure dependency in the backend
- Degradation is cleaner: if Azure is unreachable, melotts fallback still works

### Persona catalog stored in LMS, referenced by Worker

The `TutorPersona` type (already defined in TutorSession.ts) carries `voice_id`, `portrait_image_url`, and `tone_profile`. The LMS admin UI manages a catalog of personas. The Worker reads the learner's selected persona from the WebSocket message and injects `tone_profile` into the system prompt. Voice selection and portrait rendering happen browser-side.

```typescript
// Already exists — no changes needed
interface TutorPersona {
  name: string;
  voice_id: string;           // e.g. "en-US-JennyNeural" — Azure voice short name
  portrait_image_url: string;  // URL to character PNG
  tone_profile: string;        // e.g. "Warm, patient, encouraging"
}
```

### Viseme protocol: browser receives from Azure, renders on canvas

The browser connects to Azure Speech SDK. On each `VisemeReceived` event, it receives:

```typescript
{
  visemeId: number;      // 0-21 (Microsoft viseme map — 0=silence, 21=rounded lips)
  audioOffset: number;   // milliseconds from audio start — used for sync
}
```

The avatar component maps `visemeId` to a pre-rendered mouth shape sprite and composites it onto the character portrait using Canvas 2D. A `requestAnimationFrame` loop blends between shapes for smooth transitions.

### Mouth shape asset bundle

Twenty-two PNG sprites (viseme IDs 0–21). Each is a transparent mouth shape designed to overlay the character portrait at a fixed anchor position. Can be pre-rendered once per character or shared across characters with color/size adjustments at render time.

### InteractionMode unchanged

The existing `InteractionMode` type already defines `"voice-full"` (STT in + TTS out) and `"text-tts-out"` (text in, voice out). The avatar activates whenever TTS is produced — regardless of mode. No mode enum changes needed.

### WebSocket protocol extensions

Two new message types from the browser:

| Message | Direction | Shape | Purpose |
|---------|-----------|-------|---------|
| `select_persona` | Browser → Worker | `{ type: "select_persona", persona_id: string }` | Learner picks character at session start or mid-session |
| `persona` (existing) | Worker → Browser | `{ type: "mode", persona: TutorPersona, modes: [...] }` | Worker sends default persona on connect — already exists |

No changes to Worker-side audio/chunk protocol. TTS remains server-side via melotts as fallback. Azure Speech is browser-only.

### Degradation strategy

| Failure | Behavior |
|---------|----------|
| Azure Speech unreachable | Fall back to melotts TTS audio chunks (existing path). Amplitude-based mouth toggle. |
| Viseme event stream empty | Mouth stays in rest position. Audio plays normally. |
| Portrait image fails to load | Show colored silhouette placeholder with text initials. |
| AudioContext blocked (autoplay policy) | Show "tap to hear" prompt. Text answer visible immediately. |
| Entire TTS layer fails | Text-only mode. No audio, no avatar animation. Learner never loses the answer. |

## Testing Decisions

### Mock Azure Speech SDK

Create a mock that emits `VisemeReceived` events on a schedule. Mock returns a test WAV buffer and a fixed viseme timeline. Assert that the MouthCanvas draws the correct sprite at each time offset.

### Avatar state machine tests

Test the MouthCanvas compositor with known viseme sequences:
- Silence (viseme 0) → expect rest mouth
- Single viseme → expect correct sprite at correct offset
- Rapid transitions → expect blend interpolation (smooth, no snapping)
- Empty timeline → expect rest mouth throughout

### Degradation tests

- Mock Azure SDK to throw → verify melotts fallback activates
- Mock portrait 404 → verify placeholder renders
- Mock AudioContext blocked → verify "tap to hear" prompt

### Prior art

Existing tests mock `AI.run` for STT and TTS. The same pattern applies: mock Azure Speech SDK, assert viseme rendering at expected offsets. Use `vi.fn` for canvas draw calls. Follow existing test isolation pattern from `test/index.test.ts`.

## Out of Scope

- **Custom branded Azure voices** — requires Azure Custom Voice training (~$1,000+, approval process). Use standard Azure neural voices.
- **3D or Live2D avatars** — 2D canvas compositing only. ReadyPlayerMe or Spine integration is a future ticket.
- **Multi-language visemes** — Azure viseme is `en-US` only. Other languages get amplitude-based fallback.
- **Streaming visemes during LLM token generation** — viseme animation starts after the full answer is synthesized, same as current TTS flow. Real-time viseme streaming alongside token generation requires a different architecture (audio chunk interleaving).
- **Admin UI for persona management** — assumes LMS admin panel exists separately. Worker reads personas from config/LMS API, not built here.

## Further Notes

- **Azure cost:** Standard neural voices at ~$16/1M chars. Free tier covers 0.5M chars/month (~500 answers). Viseme events are $0 — included with TTS.
- **Voice catalog:** 330+ Azure voices at [aka.ms/speechstudio/voicegallery](https://speech.microsoft.com/portal/voicegallery). Curate 10-20 presets for the LMS persona picker.
- **Browser compatibility:** Azure Speech SDK supports Chrome, Edge, Safari, Firefox. Web Audio API (`AudioContext`) required — available in all modern browsers.
- **Latency:** Browser→Azure TTS is 130-450ms TTFA. Well within acceptable range for answer playback (answer starts after LLM stream completes, so audio delay is not on the critical path).
- **Portrait dimensions:** Recommend 512×512 PNG with transparent background. Mouth anchor at ~70% vertical position for consistent compositing across characters.

**Status:** ready-for-agent
