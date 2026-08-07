require('dotenv').config();
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const token = jwt.sign({
  sub: 'a5d916cd-4178-4bcc-b409-c885a389e843',
  email: 'bharatvanapalli8@gmail.com',
  role: 'user',
}, process.env.JWT_SECRET, { expiresIn: '10m' });
const csrf = crypto.randomBytes(24).toString('hex');

const cancelling = process.argv.includes('--cancel');
const endpoint = cancelling
  ? 'http://127.0.0.1:5000/api/projects/1582559f-364f-4d0e-bfde-fd18832fdaa7/agents/cancel'
  : 'http://127.0.0.1:5000/api/projects/1582559f-364f-4d0e-bfde-fd18832fdaa7/agents/execute';

fetch(endpoint, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    cookie: `token=${token}; XSRF-TOKEN=${csrf}`,
    'X-XSRF-TOKEN': csrf,
  },
  body: JSON.stringify(cancelling ? {} : {
      generationId: 'd486351a-6070-47d1-b8b5-2c8bc4156abb',
      runMode: 'grouped',
    }),
}).then(async (response) => {
  const body = await response.text();
  console.log(JSON.stringify({ status: response.status, body }));
  if (!response.ok) process.exitCode = 1;
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
