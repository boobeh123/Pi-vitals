const express = require('express');
const vitalsController = require('../controller/vitalsController');
const historyController = require('../controller/historyController');

const router = express.Router();

router.get('/', vitalsController.getDashboard);
router.get('/api/vitals', vitalsController.getVitals);
router.get('/api/history', historyController.getHistory);

module.exports = router;
