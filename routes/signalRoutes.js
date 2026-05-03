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
} = require('../controllers/signalController');
const { protect, adminOnly } = require('../middleware/authMiddleware');

// All signal routes require authentication
router.use(protect);

// GET /api/signals/live  — active signals not yet expired
router.get('/live', getLiveSignals);

// GET /api/signals/stats  — win/loss summary
router.get('/stats', getStats);

// GET /api/signals  — paginated list with optional filters
router.get('/', getSignals);

// GET /api/signals/:id
router.get('/:id', getSignalById);

// POST /api/signals  — admin only
router.post('/', adminOnly, createSignal);

// PUT /api/signals/:id  — admin only
router.put('/:id', adminOnly, updateSignal);

// DELETE /api/signals/:id  — admin only
router.delete('/:id', adminOnly, deleteSignal);

module.exports = router;
