'use strict';

const jwt = require('jsonwebtoken');

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
    next();
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
