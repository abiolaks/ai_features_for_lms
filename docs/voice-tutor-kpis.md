# Voice Tutor Pipeline — KPIs & Latency SLOs

**Date:** 2026-07-29
**Status:** Spec — track against these after implementation

## Latency SLOs

| Phase | Target | Notes |
|-------|--------|-------|
| STT (WorkersAIFluxSTT) | p50 ≤400ms | Stream audio, don't wait for full recording |
| Embed + Vectorize | p50 ≤200ms | Existing — already met in text pipeline |
| LLM first token (AI03) | p50 ≤800ms | Existing — already met in text pipeline |
| TTS first chunk (WorkersAITTS) | p50 ≤300ms | Deepgram Aura via Workers AI |
| **TTFA (Time to First Audio)** | **p50 ≤1.5s, p95 ≤2.5s** | Measured from end-of-speech |

| **Answer Complete** | **p50 ≤3s** | Text + audio + avatar all delivered |

## Pipeline KPIs

| KPI | Target | Measurement |
|-----|--------|-------------|
| TTFA | p50 ≤1.5s, p95 ≤2.5s | Span duration in `handleVoiceAsk()` |
| STT accuracy | WER ≥95% | Compare `question_transcript` to known input |
| Pipeline availability | ≥99.5% | Successful ÷ total `POST /tutor/ws` voice requests |
| Degraded fallback rate | ≤2% | `ai_status: "degraded"` responses |
| Token efficiency | No regression | Same prompt, same model, same token budget |
| TTS audio quality | No artifacts | Manual QA on sample outputs |

## Observability Spans

```
voice.ask { learner_id, org_id, modality, duration_ms }
  ├─ voice.stt { duration_ms, transcript_length, model }
  ├─ data.embed { duration_ms }                    ← existing span
  ├─ data.vectorize { duration_ms, matches }       ← existing span
  ├─ ai_gateway.generate { tier, tokens, duration_ms }  ← existing span
  └─ voice.tts { duration_ms, audio_bytes, chunk_count } ← NEW span
```

## Degradation Paths

| Failure | Behavior | Span signal |
|---------|----------|-------------|
| STT fails / empty | Return `ai_status: "degraded"`, prompt user to type | `voice.stt` span with error |
| TTS fails | Deliver text only, no audio chunks | `voice.tts` span missing or errored |
| AI03 down | Text fallback fails too — full degradation | `ai_gateway.generate` span with error |
| Vectorize empty | `"I couldn't find that in this lesson"` (existing behavior) | `data.vectorize` span with matches=0 |

## Unchanged KPIs

All existing text-pipeline metrics carry forward unchanged:
- Text TTFT (Time to First Token): already met
- Text streaming throughput: already met
- Conversation history persistence: already met
- Citation accuracy: already met

## Tracking After Implementation

1. Deploy voice tutor behind feature flag
2. Compare `voice.ask` span durations against these targets
3. Monitor `voice.tts` chunk count vs answer length (efficiency)
4. Alert if TTFA p95 exceeds 2.5s or degraded rate exceeds 2%
5. A/B test voice vs text engagement metrics
