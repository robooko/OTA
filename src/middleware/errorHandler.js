function errorHandler(err, req, res, next) {
  console.error(err);

  const status = err.status || 500;
  const body = { error: err.message || 'Internal server error' };
  if (err.details) body.details = err.details;

  res.status(status).json(body);
}

module.exports = errorHandler;
