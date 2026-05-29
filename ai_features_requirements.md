# 📘 AI Integration Expectations Summary (LMS)

**Source Document:** LMS_AI_Integration_Expectations_v1.0.pdf
**Purpose:** This document is a strategic blueprint setting the goals, outcomes, and quality bar for integrating Artificial Intelligence into the Learning Management Platform (LMS). It defines *what* AI must do, but not *how* it must be built.

---

## 🎯 I. Strategic Pillars & Core Design Principles

The entire AI strategy rests on five non-negotiable principles:

1. **Grounded (In-context):** All claims must trace back to specific, indexed platform content ("this lesson," "your learning path"). General internet knowledge is prohibited unless explicitly cited in the platform content.
2. **Explainable ("Why"):** Every suggestion or recommendation must include a clear, human-readable rationale so the user understands *why* it was presented. No "black-box" outputs.
3. **Learner Agency:** AI assists; humans act. The learner always retains final decision authority (e.g., they manually submit posts/assignments).
4. **Human-in-the-Loop for Publishing:** Admins must review and approve all AI-drafted content (assessments, course changes) before it is visible to learners.
5. **Fail Gracefully:** If the AI service fails, core LMS functions (videos, quizzes, progress tracking) must remain fully operational without interruption.

### 🛡️ Non-Negotiable Governance Rules
*   **Multi-tenant Isolation:** Data from one organization **must never** leak or be accessible to another.
*   **Data Scoping:** Learner data is strictly limited to the *authenticated user*. Admin access to aggregate data must pass through separate, permissioned endpoints.

---

## 🧠 II. Key AI Capabilities Map (ID: Capability)

The features are divided into three primary groups based on their function and user type.

### A. For the Learner Experience
| ID | Feature Name | Goal Summary | Key Expectation |
| :--- | :--- | :--- | :--- |
| **AI-01** | Onboarding & Profile Intelligence | Capture deep context to make paths meaningful from day one. | Must parse structured data (CVs, goals) and store it as a consumer profile object. |
| **AI-02** | Personalized Learning Path Generation | Provide a tailored learning sequence reflecting the learner's specific needs. | The plan must be visually presented with a short "why this fits you" explanation for every course. |
| **AI-04** | In-Lesson Grounded Q&A (Tutor) | Seamless help during active lesson consumption (reading/video). | **MUST** provide an answer *plus* citations (section, video timestamp) proving the source material. |
| **AI-05** | Study Copilot | Support broader revision for module exams. | Scope selector is mandatory: Lesson, Module, or Course. Must remain grounded in indexed content only. |
| **AI-06** | Post-Activity Insights | Close the learning loop after quizzes/lessons (coaching, not shaming). | Tone must be encouraging ("coach"), and links must go directly to relevant review material. |
| **AI-16** | Platform Assistant (Avatar) | Persistent general assistant available everywhere on the platform. | Focuses on navigation and progress ("How far am I?") rather than tutoring (that is AI-04). |

### B. For Admin and Content Creators
| ID | Feature Name | Goal Summary | Key Expectation |
| :--- | :--- | :--- | :--- |
| **AI-08** | Assessment Question Generation | Create high-quality, relevant quizzes quickly from source content. | **Admin Approval is mandatory.** Every question must trace back to a specified source lesson. |
| **AI-09** | Quality & Alignment Checks | Pre-publish checks to maintain assessment rigor and consistency. | Must flag duplicates and verify that the reading level matches the course difficulty setting. |
| **AI-12** | Org Learning Plan Tuning | Keep organizational learning plans relevant using aggregate data trends. | Suggestions must include a brief rationale (e.g., "low completion suggests prerequisite gap..."). Requires Admin approval. |
| **AI-13** | Admin Analytics Narratives | Surface the "story" inside raw dashboard numbers for non-technical Admins. | Summaries are *aggregate only*. No individual learner should be identified or highlighted. |

### C. Mentorship and System Intelligence
| ID | Feature Name | Goal Summary | Key Expectation |
| :--- | :--- | :--- | :--- |
| **AI-10** | Mentor Matching | Connect learners with the right mentor efficiently. | Must provide a compatibility score and a human-readable reason per match. |
| **AI-11** | Session Insights & Skill-Gap Analysis | Structure mentorship sessions for maximum productivity. | Compares learner's profile against the organization's defined skill framework. |

---

## ⚙️ III. Technical Requirements & Operations

### Content Indexing Layer (AI-14)
This system layer is critical as it underpins every grounded AI feature.

*   **What gets indexed:** Video transcripts, full text from documents/presentations, and body text from reading lessons.
*   **Data Lifecycle:** An index job must be automatically triggered whenever content is published or updated. Deleted content must be promptly removed.
*   **Metadata:** Every chunk of data *must* carry robust metadata (Org ID, Course ID, Lesson ID) to enforce isolation and relevance filtering.

### Data Access Boundaries
AI services are only allowed access to specific, curated "Data Products":

| Data Product | Content Included | Used By Capabilities |
| :--- | :--- | :--- |
| **Catalogue Snapshot** | Courses, modules, tags, skills, prerequisites. | AI-02 (Paths), AI-03 (Recommendations). |
| **Learner Context** | Profile, enrollments, completions, scores. | Most user-facing features (AI-02 through AI-16). |
| **Content Corpus** | Chunked text and embeddings per lesson version. | Core learning interaction (AI-04, AI-05, AI-08). |
| **Mentor Directory** | Mentor profiles, specialisations, availability. | AI-10 (Matching). |

---

## 🚀 IV. Implementation Roadmap & Critical Next Steps

### Phasing and Priorities
The rollout is structured to build credibility before scaling:

*   **Phase 1 (Pilot Credibility):** Focuses on the core, observable experience (Onboarding, Paths, Question Generation, Basic Tutor). *Goal: Pilot readiness.*
*   **Phase 2 (Deep Learning Interactions):** Deepening the learner engagement loop (Study Copilot, Insights, Mentor Matching, Platform Assistant). *Goal: Full product completeness.*
*   **Phase 3 (Organizational Intelligence):** Scaling AI to govern enterprise-wide processes (Skill Gap Analysis, Plan Tuning, Advanced Analytics). *Goal: Admin value and scale.*

### Critical Decisions Outstanding
The following items are unresolved and must be decided before development can proceed fully:

1. **Default RAG Scope:** Should the Lesson Tutor default to "lesson only" or include a module toggle? (Impacts complexity/cost).
2. **Usage Budgeting:** What are the mandatory rate limits or usage caps per organization?
3. **Conversation History Retention:** How long, and who controls deletion? (Affects GDPR compliance).

***
*This document serves as the official statement of expectations; it is a guide for outcomes, not technical implementation.*
