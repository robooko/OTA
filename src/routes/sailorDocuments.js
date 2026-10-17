const express = require('express');
const rateLimit = require('express-rate-limit');
const ctrl = require('../controllers/sailorDocuments');
const { authenticateSailor } = require('../middleware/sailorAuth');

// /api/sailor/documents -- the sailor's own documents, for sidon-ai and the
// booking sites. Clerk token (X-Sailor-Token) only; no API key.
const router = express.Router();
router.use(authenticateSailor);

// Per sailor, not per IP: guestLimiter only applies on the API-key rail.
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `sailor-upload:${req.sailor.email}`,
  handler: (req, res) => res.status(429).json({ error: 'Too many uploads, please try again later' }),
});
const rawDoc = express.raw({ type: ['application/pdf', 'image/jpeg', 'image/png'], limit: '4mb' });
const rawDocSafe = (req, res, next) => rawDoc(req, res, (err) => (err?.status === 413 ? res.status(413).json({ error: 'Files are limited to 4 MB' }) : next(err)));

router.get('/', ctrl.listDocuments);
router.post('/', uploadLimiter, rawDocSafe, ctrl.uploadDocument);
router.get('/versions/:id/file', ctrl.streamOwnVersion);
router.put('/:id', ctrl.updateDocument);
router.delete('/:id', ctrl.deleteDocument);

module.exports = router;
