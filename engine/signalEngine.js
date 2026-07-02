'use strict';

/**
 * Signal Engine
 *
 * Three-condition signal rule — ALL THREE must agree before a signal is sent:
 *
 *   1. Stochastic %K crosses above 80 (SELL) or below 20 (BUY)
 *   2. RSI crosses above 70 (SELL) or below 30 (BUY)
 *   3. MACD histogram confirms the same direction (positive = BUY, negative = SELL)
 *
 * If any one of the three disagrees → no signal.
 * This is the most accurate combination for binary options on short timeframes.
 */

const Signal = require('../models/Signal');
const User   = require('../models/User');
const { fetchCandles, tickCandle, ASSETS } = require('./priceSimulator');
const { rsi, macd, stochastic, atr } = require('./indicators');

// ── Config ────────────────────────────────────────────────────────────────────

const SIGNAL_TIMEFRAME    = '3m';
const PREP_SECS           = 10;       // signal sent 10s before candle opens
const TRADE_DURATION_SECS = 3 * 60;  // 3-minute candle/trade window
const ENTRY_DELAY_SECS    = PREP_SECS;

// ── Scoring ───────────────────────────────────────────────────────────────────

function scorePair(symbol) {
  const { highs, lows, closes } = fetchCandles(symbol, 200);
  const currentPrice = closes[closes.length - 1];

  // ── 1. Stochastic %K — must be in extreme zone ────────────────────────────
  const stochResult = stochastic(highs, lows, closes, 14, 3);
  if (!stochResult) return { direction: 'BUY', score: 0, indicators: [], notes: 'Stochastic N/A', entryPrice: +currentPrice.toFixed(6) };

  const k = stochResult.k;
  let stochDir = null;
  let stochStrength = 0;

  if (k <= 20) {
    stochDir = 'BUY';
    stochStrength = Math.min(100, Math.round(((20 - k) / 20) * 100));
  } else if (k >= 80) {
    stochDir = 'SELL';
    stochStrength = Math.min(100, Math.round(((k - 80) / 20) * 100));
  }

  // Stochastic not in extreme zone — no signal
  if (!stochDir) {
    return { direction: 'BUY', score: 0, indicators: [], notes: `Stoch %K ${k.toFixed(1)} not in extreme zone (<20 or >80)`, entryPrice: +currentPrice.toFixed(6) };
  }

  // ── 2. RSI — must be in extreme zone AND agree with Stochastic ───────────
  const rsiResult = rsi(closes, 14);
  if (!rsiResult) return { direction: 'BUY', score: 0, indicators: [], notes: 'RSI N/A', entryPrice: +currentPrice.toFixed(6) };

  const rsiVal = rsiResult.value;
  let rsiDir = null;
  let rsiStrength = 0;

  if (rsiVal <= 30) {
    rsiDir = 'BUY';
    rsiStrength = Math.min(100, Math.round(((30 - rsiVal) / 30) * 100));
  } else if (rsiVal >= 70) {
    rsiDir = 'SELL';
    rsiStrength = Math.min(100, Math.round(((rsiVal - 70) / 30) * 100));
  }

  // RSI not in extreme zone — no signal
  if (!rsiDir) {
    return { direction: 'BUY', score: 0, indicators: [], notes: `RSI ${rsiVal.toFixed(1)} not in extreme zone (<30 or >70)`, entryPrice: +currentPrice.toFixed(6) };
  }

  // RSI and Stochastic must agree on direction
  if (rsiDir !== stochDir) {
    return { direction: 'BUY', score: 0, indicators: [], notes: `RSI (${rsiDir}) and Stochastic (${stochDir}) disagree`, entryPrice: +currentPrice.toFixed(6) };
  }

  // ── 3. MACD — histogram must confirm the same direction ──────────────────
  const macdResult = macd(closes);
  if (!macdResult) return { direction: 'BUY', score: 0, indicators: [], notes: 'MACD N/A', entryPrice: +currentPrice.toFixed(6) };

  const macdDir = macdResult.direction; // 'BUY' | 'SELL' | 'NEUTRAL'

  if (macdDir === 'NEUTRAL' || macdDir !== stochDir) {
    return {
      direction: 'BUY', score: 0, indicators: [],
      notes: `MACD (${macdDir}) does not confirm ${stochDir} signal`,
      entryPrice: +currentPrice.toFixed(6),
    };
  }

  // ── All three agree — compute final confidence score ──────────────────────
  const direction = stochDir; // BUY or SELL (all three match)

  // Average strength of the three indicators (0–100 each)
  const avgStrength = (stochStrength + rsiStrength + (macdResult.strength ?? 50)) / 3;

  // ATR filter — block extreme volatility
  const atrValue = atr(highs, lows, closes, 14);
  const atrPct   = atrValue ? (atrValue / currentPrice) * 100 : 0;

  if (atrPct > 3.0) {
    return { direction, score: 0, indicators: [], notes: 'Extreme volatility — skipped', entryPrice: +currentPrice.toFixed(6) };
  }

  const volatilityMultiplier = atrPct > 1.0 ? 0.90 : 1.0;

  // Score: base 40 + indicator strength contribution, capped at 100
  const score = Math.min(100, Math.round(40 + avgStrength * 0.6 * volatilityMultiplier));

  const notes = [
    `Stoch %K ${k.toFixed(1)} / %D ${stochResult.d.toFixed(1)} (${direction === 'BUY' ? 'oversold <20' : 'overbought >80'})`,
    `RSI ${rsiVal.toFixed(1)} (${direction === 'BUY' ? 'oversold <30' : 'overbought >70'})`,
    `MACD ${direction === 'BUY' ? 'bullish' : 'bearish'} (hist ${macdResult.histogram > 0 ? '+' : ''}${macdResult.histogram})`,
  ].join(' | ');

  return {
    direction,
    score,
    indicators: ['Stochastic', 'RSI', 'MACD'],
    notes,
    entryPrice: +currentPrice.toFixed(6),
    atrPct: +atrPct.toFixed(4),
  };
}

// ── Engine ────────────────────────────────────────────────────────────────────

async function run() {
  const symbols = Object.keys(ASSETS);

  symbols.forEach((s) => tickCandle(s));

  const results = symbols.map((symbol) => {
    try {
      return { symbol, ...scorePair(symbol) };
    } catch (err) {
      console.error(`[Engine] Error scoring ${symbol}:`, err.message);
      return null;
    }
  }).filter(Boolean);

  results.sort((a, b) => b.score - a.score);
  const best = results[0];

  console.log('[Engine] Scores:', results.map((r) =>
    `${r.symbol}:${r.score}(${r.direction})`
  ).join(' | '));

  // score > 0 means all three indicators agreed — emit the signal
  if (!best || best.score === 0) {
    console.log(`[Engine] No signal — Stochastic + RSI + MACD did not all agree`);
    return null;
  }

  // Ensure system user exists
  let systemUser = await User.findOne({ email: 'system@expertsignals.ai' });
  if (!systemUser) {
    const bcrypt = require('bcryptjs');
    systemUser = await User.create({
      name: 'Signal Engine',
      email: 'system@expertsignals.ai',
      password: await bcrypt.hash(require('crypto').randomBytes(32).toString('hex'), 10),
      role: 'admin',
    });
    console.log('[Engine] Created system user');
  }

  // Expire any still-pending/active signals for this pair
  await Signal.updateMany(
    { asset: best.symbol, status: { $in: ['pending', 'active'] } },
    { $set: { status: 'skipped' } }
  );

  // Signal sent PREP_SECS (10s) before the candle opens so user can prepare.
  // entryTime = when the candle starts (user enters the trade)
  // expiryTime = entryTime + 3 minutes (candle closes)
  const now        = Date.now();
  const entryTime  = new Date(now + PREP_SECS * 1000);
  const expiryTime = new Date(now + PREP_SECS * 1000 + TRADE_DURATION_SECS * 1000);

  const signal = await Signal.create({
    asset:       best.symbol,
    direction:   best.direction,
    timeframe:   SIGNAL_TIMEFRAME,
    entryPrice:  best.entryPrice,
    entryTime,
    expiryTime,
    confidence:  best.score,
    indicators:  best.indicators,
    notes:       best.notes,
    status:      'pending',    // pending for 10s, then transitions to active
    createdBy:   systemUser._id,
    generatedBy: 'engine',
  });

  console.log(
    `[Engine] ✅ ${best.symbol} ${best.direction} ${SIGNAL_TIMEFRAME} | score=${best.score} | entry in ${PREP_SECS}s | [${best.indicators.join(', ')}]`
  );

  return signal;
}

module.exports = { run, scorePair, ENTRY_DELAY_SECS, TRADE_DURATION_SECS };
