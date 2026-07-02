/**
 * Signal Scheduler
 *
 * Runs the engine every 15 seconds continuously.
 * When the three-condition gate (Stochastic + RSI + MACD) fires, a new
 * signal is created and pushed to the dashboard immediately — without
 * waiting for previous signals to expire first.
 *
 * Multiple signals can be live on the dashboard at the same time.
 */

'use strict';

const Signal = require('../models/Signal');
const { run, TRADE_DURATION_SECS } = require('./signalEngine');

// How often to check for a new signal (seconds)
const CHECK_INTERVAL_SECS = 15;

let schedulerTimer = null;
let lifecycleTimer = null;
let isRunning      = false;
let paused         = false;

// ── Engine tick ───────────────────────────────────────────────────────────────

async function tick() {
  if (isRunning || paused) return;
  isRunning = true;

  try {
    const signal = await run();
    if (signal) {
      console.log(`[Scheduler] New signal emitted — ${signal.asset} ${signal.direction}`);
    }
  } catch (err) {
    console.error('[Scheduler] Engine error:', err.message);
  } finally {
    isRunning = false;
    if (!paused) {
      // Always retry after CHECK_INTERVAL_SECS — never wait for candle expiry
      schedulerTimer = setTimeout(tick, CHECK_INTERVAL_SECS * 1000);
    }
  }
}

// ── Lifecycle manager — runs every 5 seconds ──────────────────────────────────

async function expireStaleSignals() {
  try {
    const now = new Date();

    // pending → active when prep window (10s) has elapsed
    const activated = await Signal.updateMany(
      { status: 'pending', entryTime: { $lte: now } },
      { $set: { status: 'active' } }
    );
    if (activated.modifiedCount > 0) {
      console.log(`[Scheduler] Activated ${activated.modifiedCount} signal(s)`);
    }

    // active → skipped when candle closes with no user result
    const skipped = await Signal.updateMany(
      { status: 'active', expiryTime: { $lte: now }, result: null },
      { $set: { status: 'skipped' } }
    );
    if (skipped.modifiedCount > 0) {
      console.log(`[Scheduler] Skipped ${skipped.modifiedCount} unacted signal(s)`);
    }
  } catch (err) {
    console.error('[Scheduler] Lifecycle error:', err.message);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

function start() {
  if (schedulerTimer) {
    console.warn('[Scheduler] Already running');
    return;
  }

  paused = false;
  console.log(`[Scheduler] Starting — 10s prep + ${TRADE_DURATION_SECS}s candle`);

  // Fire immediately on startup
  schedulerTimer = setTimeout(tick, 0);

  // Lifecycle checker every 5 seconds (catches the 10s pending→active transition)
  lifecycleTimer = setInterval(expireStaleSignals, 5_000);
  expireStaleSignals();
}

function pause() {
  if (paused) return;
  paused = true;
  if (schedulerTimer) { clearTimeout(schedulerTimer); schedulerTimer = null; }
  console.log('[Scheduler] Paused');
}

function resume() {
  if (!paused) return;
  paused = false;
  console.log('[Scheduler] Resumed — firing immediately');
  schedulerTimer = setTimeout(tick, 0);
}

function stop() {
  paused = true;
  if (schedulerTimer) { clearTimeout(schedulerTimer);  schedulerTimer = null; }
  if (lifecycleTimer) { clearInterval(lifecycleTimer); lifecycleTimer = null; }
  console.log('[Scheduler] Stopped');
}

function isPaused() { return paused; }

module.exports = { start, stop, pause, resume, isPaused };
