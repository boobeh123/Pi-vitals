const express = require('express');
const vitalsController = require('../controller/vitalsController');

const router = express.Router();

router.get('/', vitalsController.getDashboard);
router.get('/api/vitals', vitalsController.getVitals);

module.exports = router;
