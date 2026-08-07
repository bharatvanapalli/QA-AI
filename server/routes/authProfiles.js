'use strict';

// Enterprise Mode P4b — AuthProfile CRUD. A declared business identity
// (admin/demo/maker/checker/…) with strategy + disposition, optionally referencing
// an AuthFixture (storageState) or a named credential. Project+org-scoped. Bad
// strategy/disposition are rejected (400); missing fixture/credential for a
// disposition that needs one is a surfaced WARNING, not a block.

const express = require('express');
const prisma = require('../prisma');
const audit = require('../services/audit');
const { resolveAuthProfile, validateAuthProfile, STRATEGIES, DISPOSITIONS } = require('../services/authProfileResolver');
const { requireAuth } = require('../middleware/auth');
const { requireOrg } = require('../middleware/org');
const { requireCsrf } = require('../middleware/csrf');

const router = express.Router({ mergeParams: true });
router.use(requireAuth);
router.use(requireOrg);

async function ownedProject(req) {
  return prisma.project.findFirst({ where: { id: req.params.projectId, orgId: req.org.id }, select: { id: true } });
}

function serialize(p) {
  if (!p) return null;
  return {
    id: p.id, name: p.name, strategy: p.strategy, disposition: p.disposition,
    authFixtureId: p.authFixtureId || null, credentialRef: p.credentialRef || null,
    environment: p.environment, notes: p.notes || null,
    createdAt: p.createdAt, updatedAt: p.updatedAt,
    resolved: resolveAuthProfile(p),
    findings: validateAuthProfile(p).findings,
  };
}

function readBody(body) {
  return {
    name: typeof body?.name === 'string' ? body.name.trim() : '',
    strategy: typeof body?.strategy === 'string' ? body.strategy.trim().toLowerCase() : 'form',
    disposition: typeof body?.disposition === 'string' ? body.disposition.trim().toLowerCase() : 'bypass_fixture',
    authFixtureId: body?.authFixtureId ? String(body.authFixtureId) : null,
    credentialRef: body?.credentialRef ? String(body.credentialRef) : null,
    environment: typeof body?.environment === 'string' && body.environment.trim() ? body.environment.trim() : 'default',
    notes: body?.notes ? String(body.notes) : null,
  };
}

// GET /api/projects/:projectId/auth-profiles
router.get('/', async (req, res, next) => {
  try {
    const project = await ownedProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const rows = await prisma.authProfile.findMany({ where: { projectId: project.id }, orderBy: { name: 'asc' } });
    res.json({ success: true, authProfiles: rows.map(serialize), strategies: STRATEGIES, dispositions: DISPOSITIONS });
  } catch (err) { next(err); }
});

// POST /api/projects/:projectId/auth-profiles
router.post('/', requireCsrf, async (req, res, next) => {
  try {
    const project = await ownedProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const fields = readBody(req.body || {});
    const check = validateAuthProfile(fields);
    const errors = check.findings.filter((f) => f.severity === 'error');
    if (errors.length) return res.status(400).json({ success: false, code: 'INVALID_AUTH_PROFILE', findings: check.findings });
    let row;
    try {
      row = await prisma.authProfile.create({ data: { projectId: project.id, ...fields, updatedAt: new Date() } });
    } catch (e) {
      if (e && e.code === 'P2002') return res.status(409).json({ success: false, code: 'DUPLICATE_NAME', message: `An auth profile named "${fields.name}" already exists.` });
      throw e;
    }
    await audit.log({ userId: req.user.id, action: 'authProfile.create', target: row.id, metadata: { projectId: project.id, name: row.name, disposition: row.disposition }, req });
    res.status(201).json({ success: true, authProfile: serialize(row) });
  } catch (err) { next(err); }
});

// PUT /api/projects/:projectId/auth-profiles/:id
router.put('/:id', requireCsrf, async (req, res, next) => {
  try {
    const project = await ownedProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const existing = await prisma.authProfile.findFirst({ where: { id: req.params.id, projectId: project.id } });
    if (!existing) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const fields = readBody({ ...existing, ...req.body });
    const check = validateAuthProfile(fields);
    const errors = check.findings.filter((f) => f.severity === 'error');
    if (errors.length) return res.status(400).json({ success: false, code: 'INVALID_AUTH_PROFILE', findings: check.findings });
    const row = await prisma.authProfile.update({ where: { id: existing.id }, data: { ...fields, updatedAt: new Date() } });
    await audit.log({ userId: req.user.id, action: 'authProfile.update', target: row.id, metadata: { projectId: project.id, name: row.name, disposition: row.disposition }, req });
    res.json({ success: true, authProfile: serialize(row) });
  } catch (err) { next(err); }
});

// DELETE /api/projects/:projectId/auth-profiles/:id
router.delete('/:id', requireCsrf, async (req, res, next) => {
  try {
    const project = await ownedProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const deleted = await prisma.authProfile.deleteMany({ where: { id: req.params.id, projectId: project.id } });
    if (!deleted.count) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    await audit.log({ userId: req.user.id, action: 'authProfile.delete', target: req.params.id, metadata: { projectId: project.id }, req });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
