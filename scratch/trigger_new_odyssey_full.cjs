const PROJECT_ID = '1582559f-364f-4d0e-bfde-fd18832fdaa7';
const CASE_IDS = [
  '4af44607-e59b-4cd4-85a2-68dc1e89cdc9', // TS1: Login through email classifier and Microsoft sign-in
  'c7dabb04-0fef-4530-bad8-8c0f6622ed64', // TS2: Create an order and validate complex form controls
];
const GENERATION_ID = 'd486351a-6070-47d1-b8b5-2c8bc4156abb';
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

  const url = 'http://localhost:5000/api/projects/' + PROJECT_ID + '/agents/run-smoke';
  console.log('Triggering run for cases:', CASE_IDS);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `${AUTH_COOKIE}; XSRF-TOKEN=${xsrfCookieValue}`,
      'X-XSRF-TOKEN': csrfToken,
    },
    body: JSON.stringify({ testCaseIds: CASE_IDS, generationId: GENERATION_ID })
  });
  console.log('STATUS:', res.status, 'BODY:', await res.text());
})();
