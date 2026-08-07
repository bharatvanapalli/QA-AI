// B-2e — trigger a flag-on conductor run (run-smoke) for a focused OrangeHRM
// set covering login/form/dropdown/autocomplete/search/table-row/record_action.
require('dotenv').config();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const BASE = 'http://localhost:5000';
const PROJECT = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const USER = { sub: 'a5d916cd-4178-4bcc-b409-c885a389e843', email: 'bharatvanapalli8@gmail.com', role: 'user' };
const testCaseIds = [
  'a306ab75-d150-42a2-a330-6cb8deb11a82', // admin: create ESS user, verify list, logout/login (dropdown/autocomplete/search/table/row)
  '80348e7e-8e56-4bea-a9f2-f5e0e4957a4d', // admin: login — menu item visible
  '4d87a5ae-91a4-4df1-b03f-c24ce99b8b80', // admin: dashboard widgets
  '5da8d348-cec4-41f9-8ce0-c5b3ea232167', // admin: login — avatar top-right
  '1ad7fc1d-c550-4de4-9154-dd45199deda6', // rbac: ESS direct nav to System Users
  'cb005040-cad6-4a90-87bb-3b982f4b1354', // rbac: admin sees all modules
  '65a8f981-470e-498e-b58c-9310adb4e498', // rbac: ESS sees only permitted modules
];
function headers() {
  const token = jwt.sign(USER, process.env.JWT_SECRET, { expiresIn: '2h' });
  const csrf = crypto.randomBytes(16).toString('hex');
  return { 'Content-Type': 'application/json', Cookie: `token=${token}; XSRF-TOKEN=${csrf}`, 'x-xsrf-token': csrf };
}
(async () => {
  const r = await fetch(`${BASE}/api/projects/${PROJECT}/agents/run-smoke`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ testCaseIds, runMode: 'sequential' }),
  });
  const body = await r.json().catch(() => ({}));
  console.log(`run-smoke → ${r.status}  ${JSON.stringify(body).slice(0, 400)}`);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
