const express = require('express');
const router = express.Router();
const {
  createSignal,
  getSignals,
  getLiveSignals,
  getSignalById,
  updateSignal,
  deleteSignal,
  getStats,
  setResult,
  cancelSignal,
} = require('../controllers/signalController');
const { protect, adminOnly } = require('../middleware/authMiddleware');

// All signal routes require authentication
router.use(protect);

// GET /api/signals/live
router.get('/live', getLiveSignals);

// GET /api/signals/stats
router.get('/stats', getStats);

// GET /api/signals
router.get('/', getSignals);

// GET /api/signals/:id
router.get('/:id', getSignalById);

// POST /api/signals/:id/result  — any authenticated user (WIN/LOSS button)
router.post('/:id/result', setResult);

// POST /api/signals/:id/cancel  — any authenticated user (CANCEL button)
router.post('/:id/cancel', cancelSignal);

// POST /api/signals  — admin only
router.post('/', adminOnly, createSignal);

// PUT /api/signals/:id  — admin only
router.put('/:id', adminOnly, updateSignal);

// DELETE /api/signals/:id  — admin only
router.delete('/:id', adminOnly, deleteSignal);

module.exports = router;
