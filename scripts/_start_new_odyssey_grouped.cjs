'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const BASE = 'http://localhost:5000';
const PROJECT_ID = '1582559f-364f-4d0e-bfde-fd18832fdaa7';
const GENERATION_ID = 'd486351a-6070-47d1-b8b5-2c8bc4156abb';
const USER = {
  sub: 'a5d916cd-4178-4bcc-b409-c885a389e843',
  email: 'bharatvanapalli8@gmail.com',
  role: 'user',
};

const token = jwt.sign(USER, process.env.JWT_SECRET, { expiresIn: '2h' });
const csrf = crypto.randomBytes(16).toString('hex');

fetch(`${BASE}/api/projects/${PROJECT_ID}/agents/execute`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Cookie: `token=${token}; XSRF-TOKEN=${csrf}`,
    'x-xsrf-token': csrf,
  },
  body: JSON.stringify({ generationId: GENERATION_ID, runMode: 'fast' }),
}).then(async (response) => {
  const body = await response.json().catch(() => ({}));
  console.log(JSON.stringify({ status: response.status, body }, null, 2));
  if (!response.ok) process.exitCode = 1;
}).catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
