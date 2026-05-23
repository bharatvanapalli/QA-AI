'use strict';

const crypto = require('crypto');

/**
 * Double-submit CSRF: token sent in non-httpOnly cookie AND in request header.
 * Issued on /api/auth/csrf-token after authentication.
 */
function issueCsrfToken(req, res) {
  const token = crypto.randomBytes(32).toString('hex');
  res.cookie('XSRF-TOKEN', token, {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 8 * 60 * 60 * 1000,
  });
  return token;
}

function requireCsrf(req, res, next) {
  // Allow safe methods through
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const cookieToken = req.cookies?.['XSRF-TOKEN'];
  const headerToken = req.headers['x-xsrf-token'];

  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res
      .status(403)
      .json({ success: false, code: 'CSRF_FAILED', message: 'Invalid CSRF token' });
  }
  next();
}

module.exports = { issueCsrfToken, requireCsrf };
