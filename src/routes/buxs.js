const express = require('express');
const ctrl = require('../controllers/buxs');

const router = express.Router();

router.use(ctrl.requireServiceSecret);
router.get('/balance', ctrl.getBalance);
router.post('/spend', ctrl.spend);
router.post('/credit', ctrl.credit);

module.exports = router;
