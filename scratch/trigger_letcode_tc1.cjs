const PROJECT_ID = 'c6a3a436-1c10-4462-9b61-f8b2ab71ebb0';
const CASE_IDS = [
  'af1b13ee-ca6d-4070-a4a1-efd8f1b93309' // Edit Fields End-to-End Flow (TC1)
];
const AUTH_COOKIE = 'token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhNWQ5MTZjZC00MTc4LTRiY2MtYjQwOS1jODg1YTM4OWU4NDMiLCJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20iLCJyb2xlIjoib3duZXIiLCJpYXQiOjE3ODYzNDQyNTB9.1aZQl4QHvtN9Ebq5qdgA29_FbHB6RIi50XTlPfcDX5c; org-id=org-a5d916cd-4178-4bcc-b409-c885a389e843';

(async () => {
  const csrfRes = await fetch('http://localhost:5000/api/auth/csrf-token', {
    headers: { Cookie: AUTH_COOKIE },
  });
  const csrfBody = await csrfRes.json();
  const csrfToken = csrfBody.csrfToken || csrfBody.token;
  const setCookie = csrfRes.headers.get('set-cookie') || '';
  const xsrfMatch = /XSRF-TOKEN=([^;]+)/.exec(setCookie);
  const xsrfCookieValue = xsrfMatch ? xsrfMatch[1] : csrfToken;
  console.log('CSRF token:', csrfToken);

  const url = 'http://localhost:5000/api/projects/' + PROJECT_ID + '/agents/run-smoke';
  console.log('Triggering run for cases:', CASE_IDS);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `${AUTH_COOKIE}; XSRF-TOKEN=${xsrfCookieValue}`,
      'X-XSRF-TOKEN': csrfToken,
    },
    body: JSON.stringify({ testCaseIds: CASE_IDS, generationId: '2f51f751-7684-40ac-a70c-533302f6695a' })
  });
  console.log('STATUS:', res.status, 'BODY:', await res.text());
})();
