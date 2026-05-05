/**
 * Signal Scheduler
 *
 * Runs the signal engine every minute on the :00 second mark.
 * Also auto-expires signals whose expiryTime has passed.
 *
 * Call start() once after MongoDB is connected.
 */

'use strict';

const Signal = require('../models/Signal');
const { run } = require('./signalEngine');

let schedulerTimer = null;
let expiryTimer    = null;
let isRunning      = false;

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
  if (isRunning) return; // prevent overlap
  isRunning = true;

  try {
    await run();
  } catch (err) {
    console.error('[Scheduler] Engine error:', err.message);
  } finally {
    isRunning = false;
    // Schedule next tick exactly at the next minute boundary
    schedulerTimer = setTimeout(tick, msUntilNextMinute());
  }
}

/**
 * Expire signals whose expiryTime has passed.
 * Runs every 15 seconds.
 */
async function expireStaleSignals() {
  try {
    const result = await Signal.updateMany(
      { status: 'active', expiryTime: { $lte: new Date() } },
      { $set: { status: 'expired' } }
    );
    if (result.modifiedCount > 0) {
      console.log(`[Scheduler] Expired ${result.modifiedCount} stale signal(s)`);
    }
  } catch (err) {
    console.error('[Scheduler] Expiry error:', err.message);
  }
}

/**
 * Start the scheduler.
 * Fires the first engine run at the next whole minute,
 * then every 60 seconds aligned to the clock.
 */
function start() {
  if (schedulerTimer) {
    console.warn('[Scheduler] Already running');
    return;
  }

  const delay = msUntilNextMinute();
  console.log(`[Scheduler] Starting — first signal in ${Math.round(delay / 1000)}s`);

  // First tick aligned to next minute
  schedulerTimer = setTimeout(tick, delay);

  // Expiry checker every 15 seconds
  expiryTimer = setInterval(expireStaleSignals, 15_000);

  // Also run expiry immediately on start
  expireStaleSignals();
}

/**
 * Stop the scheduler (useful for graceful shutdown).
 */
function stop() {
  if (schedulerTimer) { clearTimeout(schedulerTimer);  schedulerTimer = null; }
  if (expiryTimer)    { clearInterval(expiryTimer);    expiryTimer    = null; }
  console.log('[Scheduler] Stopped');
}

module.exports = { start, stop };
