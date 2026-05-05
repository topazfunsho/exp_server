const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/authRoutes');
const signalRoutes = require('./routes/signalRoutes');

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/signals', signalRoutes);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Engine status ─────────────────────────────────────────────────────────────
app.get('/api/engine/status', async (req, res) => {
  try {
    const Signal = require('./models/Signal');
    const { isPaused } = require('./engine/scheduler');
    const latest = await Signal.findOne({ generatedBy: 'engine' })
      .sort({ createdAt: -1 })
      .populate('createdBy', 'name');

    const now = Date.now();
    const nextFireMs = 60_000 - (now % 60_000);

    res.json({
      status: isPaused() ? 'paused' : 'running',
      nextSignalIn: isPaused() ? 'paused' : `${Math.round(nextFireMs / 1000)}s`,
      latestSignal: latest || null,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Engine pause / resume (protected — any logged-in user) ────────────────────
const { protect } = require('./middleware/authMiddleware');

app.post('/api/engine/pause', protect, (req, res) => {
  const { pause } = require('./engine/scheduler');
  pause();
  res.json({ status: 'paused' });
});

app.post('/api/engine/resume', protect, (req, res) => {
  const { resume } = require('./engine/scheduler');
  resume();
  res.json({ status: 'running' });
});

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ message: `Route ${req.method} ${req.originalUrl} not found` });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ message: err.message || 'Internal server error' });
});

module.exports = app;
