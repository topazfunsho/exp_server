/**
 * Signal Scheduler
 *
 * Runs the signal engine every minute on the :00 second mark.
 * Also auto-expires signals whose expiryTime has passed.
 *
 * Call start() once after MongoDB is connected.
 * Supports pause() / resume() for inactivity / logout control.
 */

'use strict';

const Signal = require('../models/Signal');
const { run } = require('./signalEngine');

let schedulerTimer = null;
let expiryTimer    = null;
let isRunning      = false;
let paused         = false;

/**
 * Calculate milliseconds until the next whole minute.
 */
function msUntilNextMinute() {
  const now = Date.now();
  return 60_000 - (now % 60_000);
}

/**
 * Run the engine and schedule the next tick.
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
    // Schedule next tick — skip if paused
    if (!paused) {
      schedulerTimer = setTimeout(tick, msUntilNextMinute());
    }
  }
}

/**
 * Expire signals whose expiryTime has passed.
 * - Signals with no result → marked 'skipped' (user never acted on them)
 * - Signals already have a result → left as-is (won/lost/draw handled by setResult)
 * Runs every 15 seconds regardless of pause state.
 */
async function expireStaleSignals() {
  try {
    // Mark active signals past expiry that have NO result as 'skipped'
    const skipped = await Signal.updateMany(
      { status: 'active', expiryTime: { $lte: new Date() }, result: null },
      { $set: { status: 'skipped' } }
    );
    if (skipped.modifiedCount > 0) {
      console.log(`[Scheduler] Skipped ${skipped.modifiedCount} unacted signal(s)`);
    }
  } catch (err) {
    console.error('[Scheduler] Expiry error:', err.message);
  }
}

/**
 * Start the scheduler.
 */
function start() {
  if (schedulerTimer) {
    console.warn('[Scheduler] Already running');
    return;
  }

  paused = false;
  const delay = msUntilNextMinute();
  console.log(`[Scheduler] Starting — first signal in ${Math.round(delay / 1000)}s`);

  schedulerTimer = setTimeout(tick, delay);
  expiryTimer    = setInterval(expireStaleSignals, 15_000);
  expireStaleSignals();
}

/**
 * Pause signal generation (engine stops firing, expiry checker keeps running).
 */
function pause() {
  if (paused) return;
  paused = true;
  if (schedulerTimer) { clearTimeout(schedulerTimer); schedulerTimer = null; }
  console.log('[Scheduler] Paused — no new signals will be generated');
}

/**
 * Resume signal generation after a pause.
 */
function resume() {
  if (!paused) return;
  paused = false;
  const delay = msUntilNextMinute();
  console.log(`[Scheduler] Resumed — next signal in ${Math.round(delay / 1000)}s`);
  schedulerTimer = setTimeout(tick, delay);
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
