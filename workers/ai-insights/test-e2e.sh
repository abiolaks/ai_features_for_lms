#!/bin/bash
# Run this in YOUR terminal (where LMS_API_KEY is exported)
set -e

LMS="https://lms-staging-api-gpeze7brdfc9akhj.southafricanorth-01.azurewebsites.net/api"
INSIGHTS="https://ai-insights.yomi-alarape.workers.dev"

echo "=== Step 1: Get assessments from LMS ==="
ASSESSMENTS=$(curl -s "$LMS/v1/learner/assessments" -H "Authorization: Bearer $LMS_API_KEY")
echo "$ASSESSMENTS" | python3 -m json.tool | head -30

# Loop through assessments to find one with attempts
FOUND=0
for ASSESS_ID in $(echo "$ASSESSMENTS" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for item in d.get('data',[]):
    print(item.get('id',''))
" 2>/dev/null); do
  echo "Checking assessment: $ASSESS_ID"
  ATTEMPTS=$(curl -s "$LMS/v1/learner/assessments/$ASSESS_ID/attempts" -H "Authorization: Bearer $LMS_API_KEY")
  ATTEMPT_COUNT=$(echo "$ATTEMPTS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('data',[])))" 2>/dev/null)
  echo "  Attempts: $ATTEMPT_COUNT"
  
  if [ "$ATTEMPT_COUNT" -gt "0" ] 2>/dev/null; then
    ATTEMPT_ID=$(echo "$ATTEMPTS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data'][0]['id'])" 2>/dev/null)
    USER_ID=$(echo "$ATTEMPTS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data'][0]['userId'])" 2>/dev/null)
    ORG_ID=$(echo "$ATTEMPTS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data'][0]['organizationId'])" 2>/dev/null)
    echo "Found attempt: $ATTEMPT_ID (user: $USER_ID, org: $ORG_ID)"
    FOUND=1
    break
  fi
done

if [ "$FOUND" -eq 0 ]; then
  echo "No assessment has attempts yet. Take a quiz on the LMS first!"
  exit 1
fi

echo ""
echo "=== Step 3: Call ai-insights worker ==="
curl -s -X POST "$INSIGHTS/insights/generate" \
  -H "Content-Type: application/json" \
  -d "{\"attempt_id\":\"$ATTEMPT_ID\",\"learner_id\":\"$USER_ID\",\"org_id\":\"$ORG_ID\"}" \
  | python3 -m json.tool
