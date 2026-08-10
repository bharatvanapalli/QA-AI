const fs = require('fs');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const token = jwt.sign({ sub: 'a5d916cd-4178-4bcc-b409-c885a389e843', email: 'test@example.com', role: 'owner' }, process.env.JWT_SECRET);
const code = `const PROJECT_ID = '1582559f-364f-4d0e-bfde-fd18832fdaa7';
const CASE_IDS = ['4af44607-e59b-4cd4-85a2-68dc1e89cdc9'];
(async () => {
  const url = 'http://localhost:5000/api/projects/' + PROJECT_ID + '/agents/run-smoke';
  console.log('Triggering run for cases:', CASE_IDS);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': 'token=${token}; org-id=org-a5d916cd-4178-4bcc-b409-c885a389e843; XSRF-TOKEN=mock_token', 'x-xsrf-token': 'mock_token' },
    body: JSON.stringify({ caseIds: CASE_IDS, mode: 'grouped' })
  });
  console.log('STATUS:', res.status, 'BODY:', await res.text());
})();`;
fs.writeFileSync('scratch/1-trigger-run-new.cjs', code);
