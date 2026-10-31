const router = require('express').Router();
const express = require('express');
const ratings = require('../lib/cleanlinessRatings');

// Public: the link in the post-stay email carries an unguessable token.
router.get('/:token', ratings.showForm);
router.post('/:token', express.urlencoded({ extended: false, limit: '16kb' }), ratings.submitForm);
router.get('/:token/opt-out', ratings.optOut);

module.exports = router;
