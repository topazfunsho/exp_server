/**
 * Signal Scheduler
 *
 * Fires the engine exactly PREP_SECS (10s) before each 3-minute candle opens,
 * so signals arrive on the dashboard with 10s prep time before entry.
 *
 * After emitting a signal the scheduler sleeps until 10s before the NEXT candle.
 * If no signal qualifies, it retries 10s before the following candle.
 */

'use strict';

const Signal = require('../models/Signal');
const { run, TRADE_DURATION_SECS, ENTRY_DELAY_SECS } = require('./signalEngine');

const CANDLE_MS = TRADE_DURATION_SECS * 1000; // 180 000 ms

/** ms until the engine should run next (10s before the next candle boundary) */
function msUntilNextRun() {
  const now           = Date.now();
  const msIntoCandle  = now % CANDLE_MS;
  const msToNextCandle = CANDLE_MS - msIntoCandle;
  // Fire ENTRY_DELAY_SECS before the candle opens
  // If we're already past that prep window, wait for the one after next
  const msToPrepWindow = msToNextCandle - ENTRY_DELAY_SECS * 1000;
  return msToPrepWindow > 0 ? msToPrepWindow : msToPrepWindow + CANDLE_MS;
}

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
      console.log(`[Scheduler] Signal emitted — ${signal.asset} ${signal.direction} | entry ${new Date(signal.entryTime).toLocaleTimeString()}`);
    } else {
      console.log('[Scheduler] No qualifying setup this candle — next check in', Math.round(msUntilNextRun() / 1000), 's');
    }
  } catch (err) {
    console.error('[Scheduler] Engine error:', err.message);
  } finally {
    isRunning = false;
    if (!paused) {
      const delay = msUntilNextRun();
      console.log(`[Scheduler] Next engine run in ${Math.round(delay / 1000)}s`);
      schedulerTimer = setTimeout(tick, delay);
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
  const delay = msUntilNextRun();
  console.log(`[Scheduler] Starting — first run in ${Math.round(delay / 1000)}s (10s before next 3m candle)`);
  schedulerTimer = setTimeout(tick, delay);

  // Lifecycle checker every 5 seconds
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
