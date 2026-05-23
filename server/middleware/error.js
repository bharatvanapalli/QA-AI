'use strict';

function notFound(req, res) {
  res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Route not found' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  console.error('[error]', err.message, err.stack);
  const status = err.status || 500;
  res.status(status).json({
    success: false,
    code: err.code || 'INTERNAL_ERROR',
    message:
      process.env.NODE_ENV === 'production'
        ? 'Internal server error'
        : err.message,
  });
}

module.exports = { notFound, errorHandler };
