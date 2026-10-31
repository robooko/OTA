const router = require('express').Router();
const ctrl = require('../controllers/housekeeping');
const { authenticate, authenticateOrApiKey, requirePermission } = require('../middleware/auth');

// Room housekeeping, staff rail (Clerk bearer) only -- the board carries
// guest names and every write is a staff action. The one exception is the
// minibar list the booking site markets. Cleaning is open to any staff
// login; inspection and setup take the named permissions (docs/superpowers/specs/2026-10-31-permissions-design.md).
const manage = requirePermission('housekeeping.manage');
const inspect = requirePermission('housekeeping.inspect');
const express = require('express');

router.get('/board', authenticate, ctrl.board);

router.get('/reports', authenticate, ctrl.reports);

router.get('/settings', authenticate, ctrl.getSettings);
router.put('/settings', authenticate, manage, ctrl.putSettings);

router.put('/overrides', authenticate, ctrl.putOverride);
router.delete('/overrides/:room_id/:date', authenticate, ctrl.deleteOverride);

router.put('/rooms/:room_id/status', authenticate, ctrl.putRoomStatus);

router.post('/jobs/:id/claim', authenticate, ctrl.claimJob);
router.delete('/jobs/:id/claim', authenticate, ctrl.unclaimJob);
router.post('/jobs/:id/start', authenticate, ctrl.startJob);
router.post('/jobs/:id/finish', authenticate, ctrl.finishJob);
router.post('/jobs/:id/inspections', authenticate, inspect, ctrl.inspectJob);

router.post('/booking-extras/:id/placed', authenticate, ctrl.placeExtra);

router.get('/minibar/items', authenticate, ctrl.listMinibarItems);
router.post('/minibar/items', authenticate, manage, ctrl.createMinibarItem);
router.put('/minibar/items/:id', authenticate, manage, ctrl.updateMinibarItem);
router.put('/minibar/lists', authenticate, manage, ctrl.putMinibarList);
// The booking site markets this list with its property key: no permission.
router.get('/minibar/list', authenticateOrApiKey, ctrl.getMinibarList);
router.put('/jobs/:id/minibar', authenticate, ctrl.recordMinibar);

router.get('/check-items', authenticate, ctrl.listCheckItems);
router.post('/check-items', authenticate, manage, ctrl.createCheckItem);
router.put('/check-items/:id', authenticate, manage, ctrl.updateCheckItem);

// Raw image body; the global express.json() leaves image/* alone.
router.post('/photos', authenticate, inspect,
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '5mb' }), ctrl.uploadPhoto);

module.exports = router;
