const express = require('express');
const cors    = require('cors');

const authRoutes   = require('./routes/authRoutes');
const signalRoutes = require('./routes/signalRoutes');
const { protect }  = require('./middleware/authMiddleware');

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth',    authRoutes);
app.use('/api/signals', signalRoutes);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── SSE — real-time signal push ───────────────────────────────────────────────
// Each authenticated client holds an open connection.
// The moment the engine saves a new signal, broadcastSignal() pushes it to
// every connected client instantly — no polling needed on the frontend.

const sseClients = new Set();

/**
 * Called by the signal engine immediately after Signal.create().
 * Sends the full signal document to every connected dashboard client.
 */
app.locals.broadcastSignal = (signal) => {
  if (sseClients.size === 0) return;
  const payload = `event: signal\ndata: ${JSON.stringify(signal)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
  console.log(`[SSE] Broadcast to ${sseClients.size} client(s)`);
};

app.get('/api/signals/stream', protect, (req, res) => {
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx/proxy buffering
  res.flushHeaders();

  // Heartbeat every 20s to keep NAT/proxy connections alive
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
  }, 20_000);

  sseClients.add(res);
  console.log(`[SSE] Client connected (total: ${sseClients.size})`);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    console.log(`[SSE] Client disconnected (total: ${sseClients.size})`);
  });
});

// ── Engine status ─────────────────────────────────────────────────────────────
app.get('/api/engine/status', async (req, res) => {
  try {
    const Signal      = require('./models/Signal');
    const { isPaused } = require('./engine/scheduler');
    const latest = await Signal.findOne({ generatedBy: 'engine' })
      .sort({ createdAt: -1 })
      .populate('createdBy', 'name');

    res.json({
      status:       isPaused() ? 'paused' : 'running',
      nextSignalIn: isPaused() ? 'paused' : 'on next qualifying setup',
      latestSignal: latest || null,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Engine pause / resume ─────────────────────────────────────────────────────
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
