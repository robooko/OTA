const router = require('express').Router();
const ctrl = require('../controllers/entityFolio');
const { authenticateOrApiKey, requireRoleOrApiKey } = require('../middleware/auth');

// Folios of bookings that aren't room stays (golf_booking, equipment_hire,
// restaurant_reservation): staff, or a FULL api key (MCP, scripts) -- same
// gate as /api/payments and the room folio.
const staffOrFullKey = [authenticateOrApiKey, requireRoleOrApiKey('admin', 'staff')];

router.get('/:kind/:id', staffOrFullKey, ctrl.getEntityFolio);
router.post('/:kind/:id/adjustments', staffOrFullKey, ctrl.addEntityAdjustment);
router.delete('/:kind/:id/adjustments/:adjustment_id', staffOrFullKey, ctrl.removeEntityAdjustment);
router.post('/:kind/:id/payments', staffOrFullKey, ctrl.recordEntityPayment);

module.exports = router;
