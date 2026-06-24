/**
 * Signal Scheduler
 *
 * Timing model — candle-aligned, no fixed intervals:
 *   1. Engine runs → emits signal with entryTime=now, expiryTime=now+3min
 *   2. Scheduler waits exactly until expiryTime (the candle closes)
 *   3. Engine runs again immediately at the start of the new candle
 *
 * This means signals are back-to-back: next signal starts the moment
 * the previous candle expires, with no gap or cooldown.
 *
 * If the engine emits no signal (score too low), retry after 10 seconds.
 */

'use strict';

const Signal = require('../models/Signal');
const { run, TRADE_DURATION_SECS } = require('./signalEngine');

let schedulerTimer = null;
let lifecycleTimer = null;
let isRunning      = false;
let paused         = false;

// ── Engine tick ───────────────────────────────────────────────────────────────

async function tick() {
  if (isRunning || paused) return;
  isRunning = true;

  let nextDelayMs = 10_000; // fallback: retry in 10s if no signal was emitted

  try {
    const signal = await run();

    if (signal) {
      // Wait until this signal's candle expires, then start the next one
      const msUntilExpiry = new Date(signal.expiryTime).getTime() - Date.now();
      nextDelayMs = Math.max(0, msUntilExpiry);
      console.log(
        `[Scheduler] Next signal in ${Math.round(nextDelayMs / 1000)}s ` +
        `(candle closes at ${new Date(signal.expiryTime).toLocaleTimeString()})`
      );
    } else {
      console.log('[Scheduler] No signal emitted — retrying in 10s');
    }
  } catch (err) {
    console.error('[Scheduler] Engine error:', err.message);
  } finally {
    isRunning = false;
    if (!paused) {
      schedulerTimer = setTimeout(tick, nextDelayMs);
    }
  }
}

// ── Lifecycle manager ─────────────────────────────────────────────────────────
// Transitions: active → skipped when expiryTime passes with no result.
// pending → active is no longer needed (signals start as 'active' immediately).

async function expireStaleSignals() {
async function expireStaleSignals() {
  try {
    const now = new Date();

    // Expire active signals whose candle has closed with no result
    const skipped = await Signal.updateMany(
      { status: 'active', expiryTime: { $lte: now }, result: null },
      { $set: { status: 'skipped' } }
    );
    if (skipped.modifiedCount > 0) {
      console.log(`[Scheduler] Expired ${skipped.modifiedCount} unacted signal(s)`);
    }

    // Also expire any legacy pending signals
    await Signal.updateMany(
      { status: 'pending', expiryTime: { $lte: now } },
      { $set: { status: 'skipped' } }
    );
  } catch (err) {
    console.error('[Scheduler] Lifecycle error:', err.message);
  }
}
}

// ── Public API ────────────────────────────────────────────────────────────────

function start() {
  if (schedulerTimer) {
    console.warn('[Scheduler] Already running');
    return;
  }

  paused = false;
  console.log(`[Scheduler] Starting — candle-aligned mode (${TRADE_DURATION_SECS}s per candle)`);

  // Fire immediately at startup
  schedulerTimer = setTimeout(tick, 0);

  // Lifecycle checker every 15 seconds
  lifecycleTimer = setInterval(expireStaleSignals, 15_000);
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

  // Check if there's a currently active signal we should wait for
  Signal.findOne({ status: 'active', generatedBy: 'engine' })
    .sort({ expiryTime: -1 })
    .then((latest) => {
      if (latest) {
        const msUntilExpiry = new Date(latest.expiryTime).getTime() - Date.now();
        const delay = Math.max(0, msUntilExpiry);
        console.log(`[Scheduler] Resumed — waiting ${Math.round(delay / 1000)}s for current candle to close`);
        schedulerTimer = setTimeout(tick, delay);
      } else {
        console.log('[Scheduler] Resumed — no active signal, firing immediately');
        schedulerTimer = setTimeout(tick, 0);
      }
    })
    .catch(() => {
      schedulerTimer = setTimeout(tick, 0);
    });
}

function stop() {
  paused = true;
  if (schedulerTimer) { clearTimeout(schedulerTimer);  schedulerTimer = null; }
  if (lifecycleTimer) { clearInterval(lifecycleTimer); lifecycleTimer = null; }
  console.log('[Scheduler] Stopped');
}

function isPaused() { return paused; }

module.exports = { start, stop, pause, resume, isPaused };
