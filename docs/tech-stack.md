# Tech Stack — Phase 1 MVP

## Stack Overview

```
┌───────────────────────────────────────────────────┐
│                 AZURE SUBSCRIPTION                  │
│                                                    │
│  ┌─ Service Bus ────────────────────────────────┐ │
│  │  Topic: content-events                        │ │
│  │  Subscription: indexing-service               │ │
│  └──────────────────────────────────────────────┘ │
│                                                    │
│  ┌─ Container Apps ─────────────────────────────┐ │
│  │  ┌─ indexing-orchestrator (Python)            │ │
│  │  ┌─ llm-gateway (Python)                      │ │
│  │  ┌─ tutor-service (Python)                    │ │
│  │  ┌─ path-generation (Python)                  │ │
│  │  ┌─ recommendation-engine (Python)            │ │
│  │  ┌─ post-activity-insights (Python)           │ │
│  │  ┌─ platform-assistant (Python)               │ │
│  │  ┌─ assessment-generation (Python)            │ │
│  └──────────────────────────────────────────────┘ │
│                                                    │
│  ┌─ Azure AI Search ────────────────────────────┐ │
│  │  Vector index, semantic ranking, skillsets     │ │
│  └──────────────────────────────────────────────┘ │
│                                                    │
│  ┌─ Azure OpenAI ───────────────────────────────┐ │
│  │  text-embedding-3-small  (embeddings)          │ │
│  │  gpt-4o                  (quality tier)        │ │
│  │  gpt-4o-mini             (standard tier)       │ │
│  └──────────────────────────────────────────────┘ │
│                                                    │
│  ┌─ Data ───────────────────────────────────────┐ │
│  │  PostgreSQL Flexible Server  (AI state)        │ │
│  │  Azure Cache for Redis      (caching)          │ │
│  │  Azure Blob Storage         (content files,    │ │
│  │                              conv archives,     │ │
│  │                              indexing artifacts)│ │
│  └──────────────────────────────────────────────┘ │
│                                                    │
│  ┌─ Azure Container Registry   (images) ──────────┘ │
│  ┌─ Application Insights       (observability) ────┘ │
│  ┌─ Managed Identity           (auth everywhere) ───┘ │
└───────────────────────────────────────────────────┘
```

## Component Details

| # | Component | Choice | Why |
|---|---|---|---|
| 1 | **Vector DB / Search** | Azure AI Search | First-party chunking + embedding via skillsets. Native semantic + hybrid search. Org/course/lesson metadata filtering. Collapses Slice 1+2 into mostly config. |
| 2 | **LLM Provider** | Azure OpenAI | Same tenant, VNet, RBAC. First-party AI Search integration. No data leaves Azure. |
| 3 | **LLM Gateway** | Custom Python service on ACA | Org-level token tracking with monthly resets — custom business logic APIM doesn't do natively. Wrap AOAI SDK. Thin service. |
| 4 | **Compute** | Azure Container Apps | Per-service isolation. Scale-to-zero for pilot. Dapr-ready for pub/sub. No 230s timeout (unlike Functions). |
| 5 | **Event Pipeline** | Azure Service Bus | Reliable pub/sub for content events. Ordering, dead-lettering. Single topic, subscription per consumer. |
| 6 | **Embedding Model** | `text-embedding-3-small` | Fast, cheap, sufficient for 512-token lesson chunks. Bump to `text-embedding-3-large` if retrieval quality needs improvement. |
| 7 | **AI State DB** | Azure PostgreSQL Flexible Server | Relational state (profiles, history, approval, budgets). Team already knows PostgreSQL. |
| 8 | **Observability** | Application Insights | One-click ACA integration. End-to-end traces across Service Bus → ACA → AI Search → AOAI. |
| 9 | **Caching** | Azure Cache for Redis | Rec Engine 24hr cache. Future semantic caching in Phase 2. |
| 10 | **Blob Storage** | Azure Blob Storage | Raw content files (platform drops here). Conversation archives (compliance). Indexing artifacts (ephemeral). App Insights log export. |
| 11 | **Identity** | Managed Identity | Zero keys in code. ACA authenticates to AI Search, AOAI, Service Bus, PostgreSQL, Blob Storage, Redis via MI. |
| 12 | **CI/CD** | GitHub Actions → ACR → ACA | Build containers, push to registry, deploy to Container Apps. Already on GitHub. |
| 13 | **IaC** | Bicep | Native Azure, no state file. Defines all resources above. |

## Model Tiers

| Tier | Model | Used By |
|---|---|---|
| Standard (fast/cheap) | `gpt-4o-mini` | Tutor (AI-04), Platform Assistant (AI-16), Post-Activity Insights (AI-06), Recommendations (AI-03), Path Generation (AI-02) |
| Quality (capable) | `gpt-4o` | Assessment Generation (AI-08), Quality Checks (AI-09) |
| Embeddings | `text-embedding-3-small` | Content Indexing (AI-14 via AI Search skillset) |

## Service-to-Service Auth Flow

```
Content indexing flow:

  Platform drops content → Blob Storage (raw/)
      │
      ├──(eventually, via Service Bus)──► indexing-orchestrator (ACA)
      │
      OR (immediate, for testing)
      │
      └── POST /index ──► indexing-orchestrator (ACA)
              │
              ├──(Managed Identity)──► Blob Storage (read raw content)
              ├──(Managed Identity)──► Azure AI Search (trigger skillset)
              │                              │
              │                              └──(Managed Identity)──► Azure OpenAI (embedding)
              └──(Managed Identity)──► Blob Storage (write indexing artifacts: indexing/)

Feature service (ACA)
    │
    ├──(Managed Identity)──► Azure AI Search (vector query)
    ├──(Managed Identity)──► Azure OpenAI (LLM call)
    ├──(Managed Identity)──► PostgreSQL (state read/write)
    ├──(Managed Identity)──► Redis (cache read/write)
    └──(Managed Identity)──► Blob Storage (conv archives: conversations/)

Application Insights ←── all components auto-instrumented
                        └── export to Blob Storage (logs/)
```

## Blob Storage Layout

```
ai-content/
  raw/            ← Platform drops content files here (triggers indexing)
  conversations/  ← Compliance archives of conversation history
  indexing/       ← Ephemeral processing artifacts (auto-deleted after successful index)
  logs/           ← Application Insights export
```

## Self-Sufficient Testing (Pre-Platform)

The AI Engineer can build and validate the entire AI pipeline before the platform team delivers event hooks or UI:

1. Manually upload sample content files to Blob Storage (`raw/`)
2. Trigger indexing via HTTP endpoint: `POST /index?path=org-1/course-1/lesson-1.txt`
3. Indexing orchestrator reads from Blob, indexes to AI Search
4. Query any feature service directly (Tutor, Path Gen, Recs, etc.) via HTTP
5. Full loop validated: content → index → retrieve → generate → response

The platform team's contract simplifies to: drop content files in Blob Storage. The Service Bus integration is a later increment.

## What We're NOT Using (and why)

| Not Using | Because |
|---|---|
| Azure Functions | 230s timeout risk for long LLM/assessment generation calls |
| AKS | Overkill for Phase 1 pilot scale (2-3 orgs) |
| APIM | Org-level budget logic is custom business logic; add in Phase 2 for rate limiting + semantic caching |
| Cosmos DB | AI state is relational (profiles, approvals, budgets); PostgreSQL is simpler |
| OpenAI direct (non-Azure) | Data leaves Azure, no AI Search integration, separate billing |
| Dapr | Adds abstraction layer not needed for Phase 1; ACA supports it natively if needed later |
| Terraform | Bicep is simpler for Azure-only; no state file to manage |
