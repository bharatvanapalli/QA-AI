'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const prisma = require('../prisma');
const { requireAuth } = require('../middleware/auth');
const { issueCsrfToken } = require('../middleware/csrf');
const { rateLimit } = require('../middleware/rateLimit');
const audit = require('../services/audit');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || JWT_SECRET + ':refresh';
const JWT_TTL = process.env.JWT_TTL || '15m';
const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TTL_DAYS || 7);
const IS_PROD = process.env.NODE_ENV === 'production';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function hashRefresh(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function setAuthCookies(res, accessToken, refreshToken) {
  res.cookie('token', accessToken, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'strict',
    maxAge: 15 * 60 * 1000,
    path: '/',
  });
  res.cookie('refresh', refreshToken, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'strict',
    maxAge: REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000,
    path: '/api/auth',
  });
}

// ── POST /api/auth/signup ──────────────────────────────────
router.post(
  '/signup',
  rateLimit({ windowMs: 60_000, max: 5, keyFn: (r) => r.ip }),
  async (req, res, next) => {
    try {
      const { email, password, firstName, lastName, organisation } = req.body || {};
      if (!email || !EMAIL_RE.test(email))
        return res.status(400).json({ success: false, code: 'INVALID_EMAIL', message: 'Valid email required' });
      if (!password || password.length < 8)
        return res.status(400).json({ success: false, code: 'WEAK_PASSWORD', message: 'Password must be 8+ chars' });

      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing)
        return res.status(409).json({ success: false, code: 'EMAIL_TAKEN', message: 'Email already registered' });

      const passwordHash = await bcrypt.hash(password, 12);
      const user = await prisma.user.create({
        data: {
          email,
          passwordHash,
          firstName: firstName || null,
          lastName: lastName || null,
          organisation: organisation || null,
          role: 'user',
        },
      });

      // Phase E8 — every new user gets a Solo org so they have a tenancy
      // boundary from the moment they sign up. Owner membership stored;
      // currentOrgId pinned. Future "accept an invite" path may switch
      // them to a different org but the Solo one stays so they always
      // have a fallback workspace they own.
      const orgName = organisation && organisation.trim()
        ? organisation.trim()
        : `${(firstName || email.split('@')[0])}'s Workspace`;
      const orgSlug = (() => {
        const base = orgName.toLowerCase()
          .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
        return `${base || 'workspace'}-${user.id.slice(0, 8)}`;
      })();
      const org = await prisma.organization.create({
        data: { name: orgName, slug: orgSlug, ownerId: user.id, plan: 'solo' },
      });
      await prisma.orgMembership.create({
        data: { orgId: org.id, userId: user.id, role: 'owner' },
      });
      await prisma.user.update({
        where: { id: user.id },
        data: { currentOrgId: org.id },
      });

      await audit.log({ userId: user.id, orgId: org.id, action: 'auth.signup', req });

      // Auto-login
      const accessToken = jwt.sign(
        { sub: user.id, email: user.email, role: user.role },
        JWT_SECRET,
        { expiresIn: JWT_TTL }
      );
      const refreshRaw = crypto.randomBytes(48).toString('hex');
      await prisma.session.create({
        data: {
          userId: user.id,
          refreshHash: hashRefresh(refreshRaw),
          userAgent: req.headers['user-agent'] || null,
          ipAddress: req.ip || null,
          expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 86400_000),
        },
      });
      setAuthCookies(res, accessToken, refreshRaw);
      issueCsrfToken(req, res);

      res.status(201).json({
        success: true,
        profile: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          organisation: user.organisation,
          createdAt: user.createdAt,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/auth/login ───────────────────────────────────
router.post(
  '/login',
  rateLimit({ windowMs: 60_000, max: 10, keyFn: (r) => r.ip }),
  async (req, res, next) => {
    try {
      const { email, password } = req.body || {};
      if (!email || !password)
        return res.status(400).json({ success: false, code: 'MISSING_FIELDS', message: 'Email and password required' });

      const user = await prisma.user.findUnique({ where: { email } });
      // Constant-time-ish: always hash even on missing user
      const dummyHash = '$2a$12$0000000000000000000000000000000000000000000000000000';
      const ok = await bcrypt.compare(password, user?.passwordHash || dummyHash);

      if (!user || !ok) {
        await audit.log({ userId: user?.id, action: 'auth.login.failed', metadata: { email }, req });
        return res.status(401).json({ success: false, code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect' });
      }

      await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

      const accessToken = jwt.sign(
        { sub: user.id, email: user.email, role: user.role },
        JWT_SECRET,
        { expiresIn: JWT_TTL }
      );
      const refreshRaw = crypto.randomBytes(48).toString('hex');
      await prisma.session.create({
        data: {
          userId: user.id,
          refreshHash: hashRefresh(refreshRaw),
          userAgent: req.headers['user-agent'] || null,
          ipAddress: req.ip || null,
          expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 86400_000),
        },
      });
      setAuthCookies(res, accessToken, refreshRaw);
      issueCsrfToken(req, res);

      await audit.log({ userId: user.id, action: 'auth.login.success', req });

      res.json({
        success: true,
        profile: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          organisation: user.organisation,
          createdAt: user.createdAt,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/auth/refresh ─────────────────────────────────
router.post('/refresh', async (req, res, next) => {
  try {
    const refresh = req.cookies?.refresh;
    if (!refresh) return res.status(401).json({ success: false, code: 'NO_REFRESH' });

    const hash = hashRefresh(refresh);
    const session = await prisma.session.findUnique({ where: { refreshHash: hash } });
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      return res.status(401).json({ success: false, code: 'INVALID_REFRESH' });
    }
    const user = await prisma.user.findUnique({ where: { id: session.userId } });
    if (!user) return res.status(401).json({ success: false, code: 'USER_GONE' });

    const accessToken = jwt.sign(
      { sub: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_TTL }
    );
    res.cookie('token', accessToken, {
      httpOnly: true,
      secure: IS_PROD,
      sameSite: 'strict',
      maxAge: 15 * 60 * 1000,
      path: '/',
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/logout ──────────────────────────────────
router.post('/logout', async (req, res) => {
  const refresh = req.cookies?.refresh;
  if (refresh) {
    try {
      await prisma.session.updateMany({
        where: { refreshHash: hashRefresh(refresh) },
        data: { revokedAt: new Date() },
      });
    } catch (_) {}
  }
  res.clearCookie('token', { path: '/' });
  res.clearCookie('refresh', { path: '/api/auth' });
  res.clearCookie('XSRF-TOKEN');
  res.json({ success: true });
});

// ── GET /api/auth/me ───────────────────────────────────────
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        organisation: true,
        lastLoginAt: true,
        createdAt: true,
      },
    });
    if (!user) return res.status(404).json({ success: false });
    res.json({ success: true, profile: user });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/auth/csrf-token ───────────────────────────────
router.get('/csrf-token', requireAuth, (req, res) => {
  const token = issueCsrfToken(req, res);
  res.json({ success: true, csrfToken: token });
});

module.exports = router;
