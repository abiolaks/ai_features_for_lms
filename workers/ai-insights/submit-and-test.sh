#!/bin/bash
# Submit a quiz via API then test ai-insights worker
set -e

LMS="https://lms-staging-api-gpeze7brdfc9akhj.southafricanorth-01.azurewebsites.net/api"
INSIGHTS="https://ai-insights.yomi-alarape.workers.dev"
ASSESS_ID="019f121f-9f64-71b6-9483-8ea456fd81c8"
AUTH="Authorization: Bearer $LMS_API_KEY"

# Step 1: Start assessment
START=$(curl -s -X POST "$LMS/v1/learner/assessments/$ASSESS_ID/start" -H "$AUTH")
ATTEMPT_ID=$(echo "$START" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('id',''))")
USER_ID=$(echo "$START" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('userId',''))")
ORG_ID=$(echo "$START" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('organizationId',''))")
echo "Attempt: $ATTEMPT_ID | User: $USER_ID | Org: $ORG_ID"

# Step 2: Get questions (pass attemptId)
echo "=== Step 2: Get questions ==="
QRESP=$(curl -s "$LMS/v1/learner/assessments/$ASSESS_ID/questions?attemptId=$ATTEMPT_ID" -H "$AUTH")
QUESTIONS_JSON=$(echo "$QRESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('questions','[]'))")
TOTAL=$(echo "$QRESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('totalQuestions',0))")
echo "Attempt: $ATTEMPT_ID | Questions: $TOTAL"

if [ "$TOTAL" -eq 0 ]; then
  echo "FAILED: 0 questions returned. Raw:" 
  echo "$QRESP" | python3 -m json.tool | head -20
  exit 1
fi

# Step 2: Build responses (first 60% correct, rest wrong)
echo ""
echo "=== Step 3: Submit answers ==="
RESPONSES=$(python3 -c "
import json, sys
qs = json.loads(sys.argv[1])
n = len(qs)
responses = []
for i, q in enumerate(qs):
    correct = q.get('correctAnswer', '')
    options = q.get('options', [])
    # First 60% correct, rest wrong
    if i < int(n * 0.6):
        selected = correct
    else:
        wrong = [o for o in options if o != correct]
        selected = wrong[0] if wrong else options[-1]
    responses.append({
        'questionId': q['id'],
        'selectedOption': selected,
        'timeSpentSeconds': 15 + (i * 5)
    })
print(json.dumps(responses))
" "$QUESTIONS_JSON")

SUBMIT=$(curl -s -X POST "$LMS/v1/learner/assessments/$ASSESS_ID/submit" \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d "{\"attemptId\":\"$ATTEMPT_ID\",\"responses\":$RESPONSES}")

echo "$SUBMIT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f'Submit: {d.get(\"success\")} — {d.get(\"message\",\"\")}')
data=d.get('data',{})
print(f'Score: {data.get(\"scorePercent\",\"?\")}% ({data.get(\"correctAnswers\",\"?\")}/{data.get(\"totalQuestions\",\"?\")})')
"

# Step 4: Call ai-insights worker
echo ""
echo "=== Step 4: Call ai-insights worker ==="
curl -s -X POST "$INSIGHTS/insights/generate" \
  -H "Content-Type: application/json" \
  -d "{\"attempt_id\":\"$ATTEMPT_ID\",\"learner_id\":\"$USER_ID\",\"org_id\":\"$ORG_ID\"}" \
  | python3 -m json.tool
