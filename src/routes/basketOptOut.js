const express = require('express');
const ctrl = require('../controllers/shopBaskets');

const router = express.Router();
// Unauthenticated by design -- the basket UUID is the capability.
router.get('/:basket_id', ctrl.basketReminderOptOut);

module.exports = router;
