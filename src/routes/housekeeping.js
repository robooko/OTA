const router = require('express').Router();
const express = require('express');
const ctrl = require('../controllers/housekeeping');
const { authenticate, authenticateOrApiKey, requirePermission, requireRoleOrApiKey } = require('../middleware/auth');

// Room housekeeping. Three rails:
//  - Cleaning (claim, start, finish, inspect, minibar count, extras placed):
//    Clerk bearer only -- each records which person did it.
//  - Setup and reads (board, reports, settings, checklist, minibar
//    catalogue/lists, overrides, room status): staff, or a FULL api key
//    (MCP, scripts). A scoped key (e.g. a booking website's) is refused --
//    the board carries guest names. Setup writes also take
//    housekeeping.manage, which scoped keys may be granted.
//  - The minibar list the booking site markets: any property key.
// Permissions: docs/superpowers/specs/2026-10-31-permissions-design.md.
const manage = requirePermission('housekeeping.manage');
const inspect = requirePermission('housekeeping.inspect');
const staffOrFullKey = [authenticateOrApiKey, requireRoleOrApiKey('admin', 'staff')];
const setup = [authenticateOrApiKey, manage];

router.get('/board', staffOrFullKey, ctrl.board);
router.get('/ably-token', staffOrFullKey, ctrl.ablyToken);
router.get('/reports', staffOrFullKey, ctrl.reports);

router.get('/settings', staffOrFullKey, ctrl.getSettings);
router.put('/settings', setup, ctrl.putSettings);

router.put('/overrides', staffOrFullKey, ctrl.putOverride);
router.delete('/overrides/:room_id/:date', staffOrFullKey, ctrl.deleteOverride);

router.put('/rooms/:room_id/status', staffOrFullKey, ctrl.putRoomStatus);

router.post('/jobs/:id/claim', authenticate, ctrl.claimJob);
router.delete('/jobs/:id/claim', authenticate, ctrl.unclaimJob);
router.post('/jobs/:id/start', authenticate, ctrl.startJob);
router.post('/jobs/:id/finish', authenticate, ctrl.finishJob);
router.post('/jobs/:id/inspections', authenticate, inspect, ctrl.inspectJob);
router.put('/jobs/:id/minibar', authenticate, ctrl.recordMinibar);

router.post('/booking-extras/:id/placed', authenticate, ctrl.placeExtra);

router.get('/minibar/items', staffOrFullKey, ctrl.listMinibarItems);
router.post('/minibar/items', setup, ctrl.createMinibarItem);
router.put('/minibar/items/:id', setup, ctrl.updateMinibarItem);
router.put('/minibar/lists', setup, ctrl.putMinibarList);
// The booking site markets this list with its property key: no permission.
router.get('/minibar/list', authenticateOrApiKey, ctrl.getMinibarList);

router.get('/check-items', staffOrFullKey, ctrl.listCheckItems);
router.post('/check-items', setup, ctrl.createCheckItem);
router.put('/check-items/:id', setup, ctrl.updateCheckItem);

// Raw image body; the global express.json() leaves image/* alone.
router.post('/photos', authenticate, inspect,
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '5mb' }), ctrl.uploadPhoto);

module.exports = router;
