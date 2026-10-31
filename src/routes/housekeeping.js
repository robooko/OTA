const router = require('express').Router();
const ctrl = require('../controllers/housekeeping');
const { authenticateOrApiKey, requirePermission } = require('../middleware/auth');

// Room housekeeping. Cleaning is open to any staff login; inspection and
// setup take the named permissions (docs/superpowers/specs/2026-10-31-permissions-design.md).
const manage = requirePermission('housekeeping.manage');
const inspect = requirePermission('housekeeping.inspect');
const express = require('express');

router.get('/board', authenticateOrApiKey, ctrl.board);

router.get('/settings', authenticateOrApiKey, ctrl.getSettings);
router.put('/settings', authenticateOrApiKey, manage, ctrl.putSettings);

router.put('/overrides', authenticateOrApiKey, ctrl.putOverride);
router.delete('/overrides/:room_id/:date', authenticateOrApiKey, ctrl.deleteOverride);

router.put('/rooms/:room_id/status', authenticateOrApiKey, ctrl.putRoomStatus);

router.post('/jobs/:id/claim', authenticateOrApiKey, ctrl.claimJob);
router.delete('/jobs/:id/claim', authenticateOrApiKey, ctrl.unclaimJob);
router.post('/jobs/:id/start', authenticateOrApiKey, ctrl.startJob);
router.post('/jobs/:id/finish', authenticateOrApiKey, ctrl.finishJob);
router.post('/jobs/:id/inspections', authenticateOrApiKey, inspect, ctrl.inspectJob);

router.post('/booking-extras/:id/placed', authenticateOrApiKey, ctrl.placeExtra);

router.get('/check-items', authenticateOrApiKey, ctrl.listCheckItems);
router.post('/check-items', authenticateOrApiKey, manage, ctrl.createCheckItem);
router.put('/check-items/:id', authenticateOrApiKey, manage, ctrl.updateCheckItem);

// Raw image body; the global express.json() leaves image/* alone.
router.post('/photos', authenticateOrApiKey, inspect,
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '5mb' }), ctrl.uploadPhoto);

module.exports = router;
