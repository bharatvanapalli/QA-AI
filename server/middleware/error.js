'use strict';

const { sanitizeUserMessage } = require('../lib/userFacingErrors');

function notFound(req, res) {
  res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Route not found' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  console.error('[error]', err.message, err.stack);
  const status = err.status || 500;
  const exposeMessage = status < 500 || err.expose === true;
  res.status(status).json({
    success: false,
    code: err.code || 'INTERNAL_ERROR',
    message: exposeMessage ? sanitizeUserMessage(err.message) : 'Internal server error',
  });
}

module.exports = { notFound, errorHandler };
