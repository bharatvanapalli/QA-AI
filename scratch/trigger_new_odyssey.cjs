const PROJECT_ID = '1582559f-364f-4d0e-bfde-fd18832fdaa7';
const CASE_IDS = [
  '4af44607-e59b-4cd4-85a2-68dc1e89cdc9'
];
(async () => {
  const url = 'http://localhost:5000/api/projects/' + PROJECT_ID + '/agents/run-smoke';
  console.log('Triggering run for cases:', CASE_IDS);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': 'token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhNWQ5MTZjZC00MTc4LTRiY2MtYjQwOS1jODg1YTM4OWU4NDMiLCJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20iLCJyb2xlIjoib3duZXIiLCJpYXQiOjE3ODYzNDQyNTB9.1aZQl4QHvtN9Ebq5qdgA29_FbHB6RIi50XTlPfcDX5c; org-id=org-a5d916cd-4178-4bcc-b409-c885a389e843' },
    body: JSON.stringify({ caseIds: CASE_IDS, mode: 'grouped' })
  });
  console.log('STATUS:', res.status, 'BODY:', await res.text());
})();
