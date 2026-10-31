const router = require('express').Router();
const ctrl = require('../controllers/bookings');
const folio = require('../controllers/folio');
const { authenticate, authenticateOrApiKey, requireRoleOrApiKey } = require('../middleware/auth');

// Status changes and the folio: staff, or a FULL api key (MCP, scripts).
// Folio card payments stay staff-only.
const staffOrFullKey = [authenticateOrApiKey, requireRoleOrApiKey('admin', 'staff')];

router.get('/', authenticateOrApiKey, ctrl.listBookings);
router.get('/:id', authenticateOrApiKey, ctrl.getBooking);
router.post('/', authenticateOrApiKey, ctrl.createBooking);
router.put('/:id', staffOrFullKey, ctrl.updateBooking);
router.delete('/:id', authenticateOrApiKey, ctrl.cancelBooking);
// Card payment for bookings on a rate plan -- see the room rate plans spec.
router.post('/:id/payment-intent', authenticateOrApiKey, ctrl.createPaymentIntent);
router.post('/:id/confirm-payment', authenticateOrApiKey, ctrl.confirmPayment);

// Guest folio (see docs/superpowers/specs/2026-09-01-guest-folio-design.md)
router.get('/:id/folio', staffOrFullKey, folio.getFolio);
router.post('/:id/folio/adjustments', staffOrFullKey, folio.addAdjustment);
router.delete('/:id/folio/adjustments/:adjustment_id', staffOrFullKey, folio.removeAdjustment);
router.post('/:id/folio/payment-intent', authenticate, folio.createFolioPaymentIntent);
router.post('/:id/folio/confirm-payment', authenticate, folio.confirmFolioPayment);

module.exports = router;
