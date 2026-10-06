const express = require('express');
const ctrl = require('../controllers/reviews');

const router = express.Router();
// Unauthenticated by design -- see controllers/reviews.js.
router.get('/:request_id', ctrl.reviewOptOut);

module.exports = router;
