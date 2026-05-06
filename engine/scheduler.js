/**
 * Signal Scheduler
 *
 * Timing model:
 *   1. Engine runs → emits a signal with:
 *        entryTime  = now + 60s  (preparation window)
 *        expiryTime = now + 60s + 180s  (3-min trade window)
 *   2. After the signal's trade window ends, wait 30s cooldown
 *   3. Then run the engine again
 *
 *   Total cycle = 60 (entry delay) + 180 (trade) + 30 (cooldown) = 270s ≈ 4.5 min
 *
 * Supports pause() / resume() for inactivity / logout control.
 */

'use strict';

const Signal = require('../models/Signal');
const { run, ENTRY_DELAY_SECS, TRADE_DURATION_SECS } = require('./signalEngine');

// 30-second cooldown after each signal's trade window closes
const COOLDOWN_SECS = 30;

// Total wait between engine runs:
// entry delay + trade duration + cooldown
const CYCLE_MS = (ENTRY_DELAY_SECS + TRADE_DURATION_SECS + COOLDOWN_SECS) * 1000;

let schedulerTimer = null;
let expiryTimer    = null;
let isRunning      = false;
let paused         = false;

/**
 * Run the engine once, then schedule the next run after a full cycle.
 */
async function tick() {
  if (isRunning || paused) return;
  isRunning = true;

  try {
    await run();
  } catch (err) {
    console.error('[Scheduler] Engine error:', err.message);
  } finally {
    isRunning = false;
    if (!paused) {
      console.log(`[Scheduler] Next signal in ${CYCLE_MS / 1000}s (${ENTRY_DELAY_SECS}s prep + ${TRADE_DURATION_SECS}s trade + ${COOLDOWN_SECS}s cooldown)`);
      schedulerTimer = setTimeout(tick, CYCLE_MS);
    }
  }
}

/**
 * Lifecycle manager — runs every 15 seconds:
 *  1. pending → active  when entryTime has passed
 *  2. active  → skipped when expiryTime has passed with no result
 */
async function expireStaleSignals() {
  try {
    const now = new Date();

    const activated = await Signal.updateMany(
      { status: 'pending', entryTime: { $lte: now } },
      { $set: { status: 'active' } }
    );
    if (activated.modifiedCount > 0) {
      console.log(`[Scheduler] Activated ${activated.modifiedCount} signal(s)`);
    }

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

/**
 * Start the scheduler.
 * Fires the first engine run immediately, then every CYCLE_MS.
 */
function start() {
  if (schedulerTimer) {
    console.warn('[Scheduler] Already running');
    return;
  }

  paused = false;
  console.log(`[Scheduler] Starting — cycle = ${CYCLE_MS / 1000}s per signal`);

  // Fire immediately on start, then cycle
  schedulerTimer = setTimeout(tick, 0);

  // Lifecycle checker every 15 seconds
  expiryTimer = setInterval(expireStaleSignals, 15_000);
  expireStaleSignals();
}

/**
 * Pause signal generation (lifecycle checker keeps running).
 */
function pause() {
  if (paused) return;
  paused = true;
  if (schedulerTimer) { clearTimeout(schedulerTimer); schedulerTimer = null; }
  console.log('[Scheduler] Paused');
}

/**
 * Resume signal generation after a pause.
 */
function resume() {
  if (!paused) return;
  paused = false;
  console.log(`[Scheduler] Resumed — next signal in ${CYCLE_MS / 1000}s`);
  schedulerTimer = setTimeout(tick, CYCLE_MS);
}

/**
 * Stop the scheduler entirely (graceful shutdown).
 */
function stop() {
  paused = true;
  if (schedulerTimer) { clearTimeout(schedulerTimer);  schedulerTimer = null; }
  if (expiryTimer)    { clearInterval(expiryTimer);    expiryTimer    = null; }
  console.log('[Scheduler] Stopped');
}

function isPaused() { return paused; }

module.exports = { start, stop, pause, resume, isPaused };
