function errorHandler(err, req, res, next) {
  console.error(err);

  // Postgres broke a lock cycle (e.g. a room pick bumping a booking while staff
  // cancel it) by aborting this transaction; nothing was saved, so retrying works.
  if (err.code === '40P01') {
    return res.status(409).json({ error: 'Busy, please retry', details: err.message });
  }

  const status = err.status || 500;
  const body = { error: err.message || 'Internal server error' };
  if (err.details) body.details = err.details;

  res.status(status).json(body);
}

module.exports = errorHandler;
