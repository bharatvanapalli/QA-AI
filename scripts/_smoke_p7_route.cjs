'use strict';
/**
 * P7a ROUTE smoke — proves the real HTTP surface of the IR-sourced export lane and
 * that the LEGACY ZIP path stays inert. Mints the owner JWT (GET needs no CSRF).
 *   node scripts/_smoke_p7_route.cjs
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const jwt = require('jsonwebtoken');
const prisma = require('../server/prisma');

const API = process.env.QAAI_API || 'http://localhost:5000';
const PID = '9675bfde-acb2-4eda-aaed-b6694b88f920';
const OWNER = 'a5d916cd-4178-4bcc-b409-c885a389e843';
const RUN = '2de0cb23-1b69-422e-b0da-e0b20cbfa8f2';
let fails = 0;
const A = (c, m, d) => { if (c) console.log('  PASS  ' + m); else { console.log('  FAIL  ' + m + (d ? '  — ' + d : '')); fails++; } };

(async () => {
  const u = await prisma.user.findUnique({ where: { id: OWNER }, select: { id: true, email: true, role: true } });
  const token = jwt.sign({ sub: u.id, email: u.email, role: u.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const headers = { cookie: `token=${token}` };
  const base = `${API}/api/projects/${PID}/output-files/download.zip`;
  const isZip = (buf) => buf && buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;

  console.log('\n[1] ?source=replayir → 200 zip, valid export');
  {
    const r = await fetch(`${base}?source=replayir&runId=${RUN}&framework=playwright-reference`, { headers });
    const buf = Buffer.from(await r.arrayBuffer());
    A(r.status === 200, `status 200 (got ${r.status})`);
    A(r.headers.get('content-type') === 'application/zip' && isZip(buf), 'body is a real zip (PK header)');
    A(r.headers.get('x-qaai-export-valid') === 'true', `X-QAAI-Export-Valid: true (got ${r.headers.get('x-qaai-export-valid')})`);
    A(buf.length > 200, `zip is non-trivial (${buf.length} bytes)`);
  }

  console.log('\n[2] unknown framework → 400');
  {
    const r = await fetch(`${base}?source=replayir&runId=${RUN}&framework=nope`, { headers });
    const j = await r.json().catch(() => ({}));
    A(r.status === 400 && j.code === 'UNKNOWN_FRAMEWORK', `400 UNKNOWN_FRAMEWORK (got ${r.status}/${j.code})`);
  }

  console.log('\n[3] all-blocked selection → 422 evidence-only (no zip)');
  {
    const r = await fetch(`${base}?source=replayir&runResultIds=does-not-exist&framework=playwright-reference`, { headers });
    const ct = r.headers.get('content-type') || '';
    const j = ct.includes('json') ? await r.json().catch(() => ({})) : {};
    A(r.status === 422 && j.code === 'ALL_BLOCKED', `422 ALL_BLOCKED (got ${r.status}/${j.code})`);
    A(j.manifest && j.manifest.allBlocked === true, 'evidence body carries the manifest (allBlocked:true)');
  }

  console.log('\n[4] BDD framework over HTTP → 200 zip (Route B via the real endpoint)');
  {
    const r = await fetch(`${base}?source=replayir&runId=${RUN}&framework=replayir-bdd`, { headers });
    const buf = Buffer.from(await r.arrayBuffer());
    A(r.status === 200 && isZip(buf), `BDD export 200 zip (got ${r.status})`);
    A(r.headers.get('x-qaai-export-valid') === 'true', `BDD X-QAAI-Export-Valid: true (got ${r.headers.get('x-qaai-export-valid')})`);
  }

  console.log('\n[5] Selenium framework over HTTP → 200 zip (selenium-reference via the real endpoint)');
  {
    const r = await fetch(`${base}?source=replayir&runId=${RUN}&framework=selenium-reference`, { headers });
    const buf = Buffer.from(await r.arrayBuffer());
    A(r.status === 200 && isZip(buf), `Selenium export 200 zip (got ${r.status})`);
    A(r.headers.get('x-qaai-export-valid') === 'true', `Selenium X-QAAI-Export-Valid: true (got ${r.headers.get('x-qaai-export-valid')})`);
  }

  console.log('\n[6] legacy path (no ?source) is INERT — unchanged behaviour');
  {
    const r = await fetch(`${base}?runId=${RUN}`, { headers });
    const buf = Buffer.from(await r.arrayBuffer());
    // Run 2de0cb23 has on-disk codegen from the run, so legacy returns its zip as before.
    A(r.status === 200 && isZip(buf), `legacy download still 200 zip (got ${r.status})`);
    A(!r.headers.get('x-qaai-export-valid'), 'legacy response has NO replayir header (path untouched)');
  }

  console.log(`\n${fails === 0 ? 'PASS — P7a route: IR-sourced export live over HTTP; legacy ZIP inert' : 'FAIL — ' + fails + ' check(s) failed'}\n`);
  await prisma.$disconnect();
  process.exit(fails === 0 ? 0 : 1);
})().catch(async (e) => { console.error('ROUTE SMOKE ERROR', e); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });
