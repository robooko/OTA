async function me(req, res, next) {
  try {
    res.json({ property_id: req.property_id, role: req.user.role });
  } catch (err) { next(err); }
}

module.exports = { me };
