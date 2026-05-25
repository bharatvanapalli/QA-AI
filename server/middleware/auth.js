'use strict';

const jwt = require('jsonwebtoken');
const { runAsUser } = require('../lib/userContext');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('[auth] JWT_SECRET is required');

function requireAuth(req, res, next) {
  const token = req.cookies?.token;
  if (!token) {
    return res
      .status(401)
      .json({ success: false, code: 'NO_SESSION', message: 'Not signed in' });
  }
  jwt.verify(token, JWT_SECRET, (err, payload) => {
    if (err) {
      res.clearCookie('token');
      return res
        .status(401)
        .json({ success: false, code: 'INVALID_SESSION', message: 'Session expired' });
    }
    req.user = { id: payload.sub, email: payload.email, role: payload.role };
    // E10.3 — open an AsyncLocalStorage scope keyed on this user so any
    // downstream provider.complete() call can read userId for budget
    // accounting without threading it through every agent signature.
    // orgId is set later by requireOrg; ALS scope is mutated in-place
    // there since we can't re-run the scope after this point.
    runAsUser(payload.sub, null, () => next());
  });
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, code: 'NO_SESSION' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res
        .status(403)
        .json({ success: false, code: 'FORBIDDEN', message: 'Insufficient role' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
