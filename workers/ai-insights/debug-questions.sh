#!/bin/bash
# Debug questions endpoint
LMS="https://lms-staging-api-gpeze7brdfc9akhj.southafricanorth-01.azurewebsites.net/api"
ASSESS_ID="019f121f-9f64-71b6-9483-8ea456fd81c8"
AUTH="Authorization: Bearer $LMS_API_KEY"

echo "=== Raw questions response ==="
curl -s "$LMS/v1/learner/assessments/$ASSESS_ID/questions" -H "$AUTH" | python3 -c "
import sys, json
d = json.load(sys.stdin)
data = d.get('data', {})
qs_raw = data.get('questions', '')
print(f'success: {d.get(\"success\")}')
print(f'totalQuestions: {data.get(\"totalQuestions\")}')
print(f'attemptId: {data.get(\"attemptId\")}')
print(f'questions type: {type(qs_raw).__name__}, length: {len(str(qs_raw))}')
try:
    qs = json.loads(qs_raw)
    print(f'questions parsed: {len(qs)} items')
    for q in qs[:2]:
        print(f'  - {q.get(\"id\",\"?\")}: {q.get(\"questionText\",\"?\")[:60]}... options={q.get(\"options\",[])}')
except:
    print(f'questions raw: {str(qs_raw)[:200]}')
"
