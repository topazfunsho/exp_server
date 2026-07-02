/**
 * Signal Scheduler — candle-aligned, no fixed intervals
 *
 * Timing model:
 *   1. Engine runs → creates signal with:
 *        status    = 'pending'
 *        entryTime = now + 10s   (user has 10s to prepare)
 *        expiryTime = entryTime + 3min  (candle closes)
 *   2. After 10s: lifecycle checker transitions signal pending → active
 *   3. Scheduler waits until expiryTime, then immediately runs engine again
 *
 * If the engine finds no high-confidence setup, it retries in 10s.
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

  let nextDelayMs = 10_000; // retry in 10s if no signal emitted

  try {
    const signal = await run();

    if (signal) {
      // Wait until this candle expires, then fire next signal immediately
      const msUntilExpiry = new Date(signal.expiryTime).getTime() - Date.now();
      nextDelayMs = Math.max(0, msUntilExpiry);
      console.log(
        `[Scheduler] Next signal after candle closes in ${Math.round(nextDelayMs / 1000)}s ` +
        `(${new Date(signal.expiryTime).toLocaleTimeString()})`
      );
    } else {
      console.log('[Scheduler] No qualifying signal — retrying in 10s');
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

// ── Lifecycle manager — runs every 5 seconds ──────────────────────────────────
// 1. pending → active  when entryTime is reached (10s after signal creation)
// 2. active  → skipped when expiryTime passes with no user result

async function expireStaleSignals() {
  try {
    const now = new Date();

    // Activate signals whose 10s prep window has elapsed
    const activated = await Signal.updateMany(
      { status: 'pending', entryTime: { $lte: now } },
      { $set: { status: 'active' } }
    );
    if (activated.modifiedCount > 0) {
      console.log(`[Scheduler] Activated ${activated.modifiedCount} signal(s) — entry time reached`);
    }

    // Skip signals whose candle has closed with no user result
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

  // If there's an active signal, wait for it to expire before firing next
  Signal.findOne({ status: { $in: ['pending', 'active'] }, generatedBy: 'engine' })
    .sort({ expiryTime: -1 })
    .then((latest) => {
      if (latest) {
        const delay = Math.max(0, new Date(latest.expiryTime).getTime() - Date.now());
        console.log(`[Scheduler] Resumed — waiting ${Math.round(delay / 1000)}s for current candle to close`);
        schedulerTimer = setTimeout(tick, delay);
      } else {
        console.log('[Scheduler] Resumed — firing immediately');
        schedulerTimer = setTimeout(tick, 0);
      }
    })
    .catch(() => { schedulerTimer = setTimeout(tick, 0); });
}

function stop() {
  paused = true;
  if (schedulerTimer) { clearTimeout(schedulerTimer);  schedulerTimer = null; }
  if (lifecycleTimer) { clearInterval(lifecycleTimer); lifecycleTimer = null; }
  console.log('[Scheduler] Stopped');
}

function isPaused() { return paused; }

module.exports = { start, stop, pause, resume, isPaused };
