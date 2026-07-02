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

// ── SSE — real-time signal push ───────────────────────────────────────────────
// Clients connect once; the server pushes a 'signal' event the moment a new
// signal is saved by the engine. No polling needed on the frontend.

const sseClients = new Set();

// Expose broadcaster so the engine can call it after Signal.create()
app.locals.broadcastSignal = (signal) => {
  const data = JSON.stringify(signal);
  for (const res of sseClients) {
    try { res.write(`event: signal\ndata: ${data}\n\n`); } catch { sseClients.delete(res); }
  }
};

app.get('/api/signals/stream', protect, (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering
  res.flushHeaders();

  // Send a heartbeat every 25s to keep the connection alive
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
  }, 25_000);

  sseClients.add(res);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});
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

// ── Engine pause / resume and SSE auth ───────────────────────────────────────
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
