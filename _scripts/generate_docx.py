#!/usr/bin/env python3
"""Simple, focused docx — what AI team delivers, blockers, platform inputs, timeline."""

from docx import Document
from docx.shared import Inches, Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_ALIGN_VERTICAL
from docx.enum.section import WD_ORIENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
import datetime

doc = Document()

# Page setup
for section in doc.sections:
    section.page_width = Cm(29.7)
    section.page_height = Cm(21)
    section.top_margin = Cm(2)
    section.bottom_margin = Cm(2)
    section.left_margin = Cm(2.5)
    section.right_margin = Cm(2.5)

style = doc.styles['Normal']
style.font.name = 'Calibri'
style.font.size = Pt(11)
style.paragraph_format.space_after = Pt(4)
style.paragraph_format.line_spacing = 1.1

HEADER_BG = '1F4E79'
HEADER_FG = RGBColor(255, 255, 255)
ALT_ROW = 'E8F0F8'
RED = 'C0392B'
ORANGE = 'E67E22'
GREEN = '27AE60'

def set_shading(cell, color):
    shd = OxmlElement('w:shd')
    shd.set(qn('w:fill'), color)
    shd.set(qn('w:val'), 'clear')
    cell._tc.get_or_add_tcPr().append(shd)

def heading(text, level=1):
    h = doc.add_heading(text, level=level)
    for r in h.runs:
        r.font.color.rgb = RGBColor(31, 78, 121)
    return h

def table(headers, rows, widths=None):
    t = doc.add_table(rows=1+len(rows), cols=len(headers))
    t.style = 'Table Grid'
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    for i, h in enumerate(headers):
        c = t.rows[0].cells[i]
        c.text = ''
        p = c.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r = p.add_run(str(h))
        r.bold = True; r.font.size = Pt(10); r.font.color.rgb = HEADER_FG
        set_shading(c, HEADER_BG)
        c.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
    for ri, row in enumerate(rows):
        for ci, val in enumerate(row):
            c = t.rows[1+ri].cells[ci]
            c.text = ''
            p = c.paragraphs[0]
            p.alignment = WD_ALIGN_PARAGRAPH.LEFT
            r = p.add_run(str(val))
            r.font.size = Pt(10)
            if ri % 2: set_shading(c, ALT_ROW)
            c.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
            p.paragraph_format.space_before = Pt(2)
            p.paragraph_format.space_after = Pt(2)
    if widths:
        for i, w in enumerate(widths):
            for row in t.rows:
                row.cells[i].width = Cm(w)
    doc.add_paragraph()
    return t


# ============================================================
# TITLE
# ============================================================
doc.add_paragraph()
doc.add_paragraph()
tp = doc.add_paragraph()
tp.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = tp.add_run('AI Features for LMS — Phase 1 MVP')
r.bold = True; r.font.size = Pt(24); r.font.color.rgb = RGBColor(31, 78, 121)

sp = doc.add_paragraph()
sp.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = sp.add_run('AI Engineering Team: Quick Wins & Delivery Plan')
r.font.size = Pt(14); r.font.color.rgb = RGBColor(89, 89, 89)

doc.add_paragraph()
mp = doc.add_paragraph()
mp.alignment = WD_ALIGN_PARAGRAPH.CENTER
mp.add_run(f'{datetime.date.today().strftime("%B %d, %Y")}').font.size = Pt(11)

doc.add_page_break()


# ============================================================
# 1. WHAT THE AI TEAM DELIVERS
# ============================================================
heading('1. What the AI Engineering Team Delivers', 1)

doc.add_paragraph('5 quick wins delivered over 6 weeks. Each is independently testable and demoable. '
                  'Services are Python microservices running on Azure Container Apps.')

doc.add_paragraph()

table(
    ['#', 'Quick Win', 'What It Does', 'Why First', 'Effort', 'Week'],
    [
        ['1', 'LLM Gateway',
         'Single entry point for all AI model calls. Routes to fast model (GPT-4o-mini) for chat or capable model (GPT-4o) for content generation. Tracks usage per customer organization. Enforces budget caps.',
         'Everything else calls this. No dependencies. Standalone service.',
         '1 week', 'Week 1'],
        ['2', 'Content Indexing',
         'Converts course lessons into searchable AI format. Splits text into chunks, generates embeddings (AI-friendly representations), stores in Azure AI Search with metadata (which course, lesson, section).',
         'Every grounded AI feature needs indexed content. Can be tested before platform is ready.',
         '1-2 weeks', 'Week 2-3'],
        ['3', 'Learner Profiles',
         'Stores what we know about each learner: skills, goals, role, experience level. Simple create/read/update service. Used later for personalized paths and recommendations.',
         'Simple CRUD. No AI dependency. Builds foundation for personalization.',
         '1 week', 'Week 2-3'],
        ['4', 'Search & Retrieval',
         'Given a question and a lesson, finds the most relevant sections of content. Enforces customer data isolation. Returns source citations (lesson title, section, timestamp).',
         'Thin wrapper around AI Search. Enables the Tutor.',
         '1 week', 'Week 3-4'],
        ['5', 'In-Lesson Tutor',
         'Learner asks a question while studying — gets an answer grounded in the lesson material with citations proving where the answer came from. Conversation history kept for 30 days, learner can delete anytime.',
         'The signature feature. What learners will actually use. First demo in Week 4.',
         '1-2 weeks', 'Week 4-6'],
    ],
    widths=[0.8, 2.8, 8.5, 5.5, 1.5, 1.5]
)


# ============================================================
# 2. FULL TIMELINE
# ============================================================
heading('2. Development Timeline', 1)

doc.add_paragraph('Parallel tracks start Week 1. Quick wins (QW1-5) complete by Week 6. '
                  'Remaining 7 features build on this foundation in Weeks 5-8.')

doc.add_paragraph()

table(
    ['Feature', 'Wk 1', 'Wk 2', 'Wk 3', 'Wk 4', 'Wk 5', 'Wk 6', 'Wk 7', 'Wk 8', 'Status'],
    [
        ['LLM Gateway (QW1)',             'Build', '', '', '', '', '', '', '', 'Quick Win'],
        ['Content Indexing (QW2)',         'Build', 'Build', '', '', '', '', '', '', 'Quick Win'],
        ['Learner Profiles (QW3)',         'Build', '', '', '', '', '', '', '', 'Quick Win'],
        ['Search & Retrieval (QW4)',       '', '', 'Build', '', '', '', '', '', 'Quick Win'],
        ['In-Lesson Tutor (QW5)',          '', '', '', 'Build', 'Build', '', '', '', 'Quick Win'],
        ['Post-Activity Insights',         '', '', '', '', 'Build', '', '', '', ''],
        ['Learning Paths',                 '', '', '', '', 'Build', 'Build', '', '', ''],
        ['Assessment Generation',          '', '', '', '', 'Build', 'Build', '', '', ''],
        ['Course Recommendations',         '', '', '', '', '', '', 'Build', 'Build', ''],
        ['Platform Assistant',             '', '', '', '', '', '', 'Build', 'Build', ''],
        ['Quality Checks',                 '', '', '', '', '', '', '', 'Build', ''],
        ['Fail-Graceful Handling',         '', '', '', '', '', '', '', 'Build', ''],
    ],
    widths=[5, 2, 2, 2, 2, 2, 2, 2, 2, 2]
)

doc.add_paragraph()
p = doc.add_paragraph()
r = p.add_run('First demo: Week 4 ')
r.bold = True
p.add_run('(LLM Gateway + Indexing + Search + Tutor = learner asks a question, gets an answer with citations from the course material).')

p = doc.add_paragraph()
r = p.add_run('MVP quick wins complete: Week 6 ')
r.bold = True
p.add_run('(all 5 quick wins delivered and testable).')

p = doc.add_paragraph()
r = p.add_run('Full Phase 1 complete: Week 8-10 ')
r.bold = True
p.add_run('(all 12 features including admin tools, recommendations, and production readiness).')


# ============================================================
# 3. FEASIBILITY
# ============================================================
heading('3. Feasibility Assessment', 1)

table(
    ['Factor', 'Assessment', 'Confidence'],
    [
        ['Technical complexity',
         'Azure AI Search handles the hard parts (chunking, embeddings, vector search). '
         'Our code is mostly orchestration and configuration. The Tutor is approximately 500 lines of Python.',
         'High'],
        ['Team capacity',
         '3 parallel tracks in Week 1 (Gateway, Indexing, Profiles). All are independent — no coordination overhead. '
         '8-10 weeks total for one AI engineer.',
         'High'],
        ['Dependencies on platform team',
         'Minimal. Only need: content files in Blob Storage and a skill taxonomy list. '
         'All AI services can be built and tested standalone via HTTP endpoints before platform UI exists.',
         'High'],
        ['Azure service availability',
         'All services are generally available. Risk: AOAI model capacity in target region (mitigated by provisioning in Week 0).',
         'Medium'],
        ['Cost',
         'Pilot scale (2-3 organizations). Azure Container Apps scale-to-zero eliminates idle costs. '
         'GPT-4o-mini is cost-efficient for chat. GPT-4o used sparingly for content generation.',
         'High'],
    ],
    widths=[3.5, 16.5, 2.5]
)


# ============================================================
# 4. WHAT THE PLATFORM TEAM MUST PROVIDE
# ============================================================
heading('4. What the Platform Team Must Provide', 1)

doc.add_paragraph('These inputs are required from the platform engineering team. '
                  'Items marked "Week 0" are needed before AI development starts. '
                  'Items marked with a week number are needed by that week.')

doc.add_paragraph()

table(
    ['#', 'Input Needed', 'Required By', 'Why'],
    [
        ['P1', 'Content files (lesson text, transcripts) uploaded to Blob Storage',
         'Week 1', 'Indexing pipeline needs content to index. Can be sample content initially.'],
        ['P2', 'Skill taxonomy — list of valid skills learners can select',
         'Week 2', 'Learner Profile Service validates skills against this list. Can be a static file initially.'],
        ['P3', 'Course and lesson metadata (IDs, titles, module structure)',
         'Week 3', 'Indexing needs course/lesson IDs for metadata. Search needs module structure for scope filtering.'],
        ['P4', 'Catalogue data (courses, tags, prerequisites, estimated effort)',
         'Week 5', 'Learning Paths and Recommendations need course data to generate suggestions.'],
        ['P5', 'Quiz result data (scores, per-question correctness, lesson context)',
         'Week 5', 'Post-Activity Insights needs quiz results to generate coaching feedback.'],
        ['P6', 'Learner enrollment and progress data',
         'Week 6', 'Platform Assistant needs progress data to answer "How far am I?" questions.'],
        ['P7', 'Admin review UI (for approving generated assessments)',
         'Week 6', 'Assessment Generation needs a UI where admins can review, approve, reject, or edit questions.'],
        ['P8', 'Learner-facing UI surfaces (chat box, dashboard widgets, quiz results page)',
         'Week 4', 'Tutor and other features need UI surfaces for learners to interact with. AI team provides APIs only.'],
    ],
    widths=[0.8, 9.5, 2.2, 10.5]
)


# ============================================================
# 5. BLOCKERS
# ============================================================
heading('5. Blockers & Risks', 1)

doc.add_paragraph('All HIGH severity items must be resolved before development starts (Week 0).')

doc.add_paragraph()

severity_map = {'HIGH': RED, 'MEDIUM': ORANGE, 'LOW': GREEN}

t = doc.add_table(rows=7, cols=4)
t.style = 'Table Grid'
t.alignment = WD_TABLE_ALIGNMENT.CENTER

hdrs = ['Risk', 'Severity', 'Impact if Not Resolved', 'Mitigation']
for i, h in enumerate(hdrs):
    c = t.rows[0].cells[i]
    c.text = ''
    p = c.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run(h)
    r.bold = True; r.font.size = Pt(10); r.font.color.rgb = HEADER_FG
    set_shading(c, HEADER_BG)

risks = [
    ['Azure OpenAI models not available in target region',
     'HIGH',
     'Cannot generate any AI responses. Project blocked.',
     'Provision AOAI in Week 0. Identify backup region.'],
    ['AI Search tier cannot support vector search',
     'HIGH',
     'Cannot index or search content. All grounded features blocked.',
     'Provision Standard S1 in Week 0. Verify quota.'],
    ['Platform team delays on content and data delivery',
     'HIGH',
     'AI services built but cannot be tested with real data.',
     'AI team tests with synthetic content. HTTP endpoints work without platform UI.'],
    ['Tutor response too slow (target: under 5 seconds)',
     'MEDIUM',
     'Poor learner experience. May need to adjust model or chunk size.',
     'Monitor from Day 1 with Application Insights. Tune as needed.'],
    ['No real course content for development',
     'MEDIUM',
     'Cannot validate retrieval quality with real material.',
     'Use fabricated content for development. Real content for pilot.'],
    ['Stakeholders want open-source models in Phase 1',
     'LOW',
     'Scope creep. Delays Phase 1 delivery.',
     'Gateway supports any model from Day 1. Adding a model is config, not code. Phase 2 deliverable.'],
]

for ri, (risk, severity, impact, mitigation) in enumerate(risks):
    for ci, val in enumerate([risk, severity, impact, mitigation]):
        c = t.rows[1+ri].cells[ci]
        c.text = ''
        p = c.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER if ci == 1 else WD_ALIGN_PARAGRAPH.LEFT
        r = p.add_run(str(val))
        r.font.size = Pt(10)
        if ci == 1:
            color = severity_map.get(severity, '808080')
            set_shading(c, color)
            r.font.color.rgb = RGBColor(255, 255, 255)
            r.bold = True
        elif ri % 2:
            set_shading(c, ALT_ROW)
        c.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
        p.paragraph_format.space_before = Pt(2)
        p.paragraph_format.space_after = Pt(2)

widths = [6, 2, 5.5, 9.5]
for i, w in enumerate(widths):
    for row in t.rows:
        row.cells[i].width = Cm(w)


# ============================================================
# 6. DELIVERY SUMMARY
# ============================================================
doc.add_page_break()
heading('6. Delivery Summary', 1)

table(
    ['Metric', 'Value'],
    [
        ['Quick wins delivered by AI team', '5'],
        ['Quick win delivery window', 'Week 1 to Week 6'],
        ['First working demo', 'Week 4 (In-Lesson Tutor with grounded answers and citations)'],
        ['Total features in Phase 1', '12 (5 quick wins + 7 additional features)'],
        ['Total effort', '8-10 weeks'],
        ['AI team size', '1 AI Engineer'],
        ['Platform team inputs needed', '8 items (see Section 4)'],
        ['Blockers to resolve immediately', '3 HIGH severity (AOAI capacity, AI Search tier, platform content availability)'],
        ['Technology stack', 'Azure OpenAI, Azure AI Search, Azure Container Apps, PostgreSQL, Redis, Blob Storage, Service Bus'],
    ],
    widths=[7.5, 15.5]
)


# ============================================================
# SAVE
# ============================================================
out = '/Users/abiolaks/workspace/ai_features_for_lms/docs/quick-wins-implementation-plan.docx'
doc.save(out)
print(f'Saved: {out}')
