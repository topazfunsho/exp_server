'use strict';

/**
 * Signal Engine
 *
 * Uses four classic binary-options indicators:
 *   RSI (14)              — oversold / overbought momentum
 *   MACD (12, 26, 9)      — trend direction and crossover
 *   Stochastic (14, 3)    — %K/%D momentum oscillator
 *   Bollinger Bands (20)  — price deviation from mean
 *
 * Each indicator votes BUY or SELL with a strength 0–100.
 * The pair with the highest combined score wins.
 * Direction is whichever side (bull/bear) scores higher.
 */

const Signal = require('../models/Signal');
const User   = require('../models/User');
const { fetchCandles, tickCandle, ASSETS } = require('./priceSimulator');
const { rsi, macd, bollingerBands, stochastic, atr } = require('./indicators');

// ── Config ────────────────────────────────────────────────────────────────────

const MIN_SCORE           = 0;       // always emit — 50/50 mode
const TIMEFRAME_OPTIONS   = ['3m', '4m'];
const ENTRY_DELAY_SECS    = 60;      // 1 min prep window before entry
const TRADE_DURATION_SECS = 3 * 60; // 3-min trade window

// Equal weight across all four indicators (sum = 100)
const WEIGHTS = {
  rsi:        25,
  macd:       25,
  stochastic: 25,
  bollinger:  25,
};

// ── Scoring ───────────────────────────────────────────────────────────────────

function scorePair(symbol) {
  const { highs, lows, closes } = fetchCandles(symbol, 200);
  const currentPrice = closes[closes.length - 1];

  let bullScore = 0;
  let bearScore = 0;
  const activeIndicators = [];
  const notes = [];

  // ── RSI (14) ──────────────────────────────────────────────────────────────
  // BUY  when RSI ≤ 40 (oversold momentum turning up)
  // SELL when RSI ≥ 60 (overbought momentum turning down)
  const rsiResult = rsi(closes, 14);
  if (rsiResult) {
    const v = rsiResult.value;
    if (v <= 40) {
      // Strength scales: RSI 40 → 0%, RSI 0 → 100%
      const strength = Math.min(100, Math.round(((40 - v) / 40) * 100));
      bullScore += (strength / 100) * WEIGHTS.rsi;
      activeIndicators.push('RSI');
      notes.push(`RSI ${v} (oversold)`);
    } else if (v >= 60) {
      const strength = Math.min(100, Math.round(((v - 60) / 40) * 100));
      bearScore += (strength / 100) * WEIGHTS.rsi;
      activeIndicators.push('RSI');
      notes.push(`RSI ${v} (overbought)`);
    } else {
      // Neutral zone — still give a small directional nudge based on which side of 50
      const nudge = ((50 - v) / 50) * WEIGHTS.rsi * 0.3; // max 30% of weight
      if (v < 50) bullScore += nudge;
      else        bearScore += nudge;
    }
  }

  // ── MACD (12, 26, 9) ──────────────────────────────────────────────────────
  // BUY  when histogram > 0 (MACD above signal line — bullish momentum)
  // SELL when histogram < 0 (MACD below signal line — bearish momentum)
  const macdResult = macd(closes);
  if (macdResult) {
    const contribution = (macdResult.strength / 100) * WEIGHTS.macd;
    if (macdResult.direction === 'BUY') {
      bullScore += contribution;
      activeIndicators.push('MACD');
      notes.push(`MACD bullish (hist ${macdResult.histogram > 0 ? '+' : ''}${macdResult.histogram})`);
    } else if (macdResult.direction === 'SELL') {
      bearScore += contribution;
      activeIndicators.push('MACD');
      notes.push(`MACD bearish (hist ${macdResult.histogram})`);
    }
  }

  // ── Stochastic Oscillator (14, 3) ─────────────────────────────────────────
  // BUY  when %K ≤ 30 (oversold — price near recent lows, likely to bounce)
  // SELL when %K ≥ 70 (overbought — price near recent highs, likely to drop)
  const stochResult = stochastic(highs, lows, closes, 14, 3);
  if (stochResult) {
    const k = stochResult.k;
    if (k <= 30) {
      const strength = Math.min(100, Math.round(((30 - k) / 30) * 100));
      bullScore += (strength / 100) * WEIGHTS.stochastic;
      activeIndicators.push('Stochastic');
      notes.push(`Stoch %K ${k} / %D ${stochResult.d} (oversold)`);
    } else if (k >= 70) {
      const strength = Math.min(100, Math.round(((k - 70) / 30) * 100));
      bearScore += (strength / 100) * WEIGHTS.stochastic;
      activeIndicators.push('Stochastic');
      notes.push(`Stoch %K ${k} / %D ${stochResult.d} (overbought)`);
    } else {
      // Neutral — small nudge toward the closer extreme
      const nudge = ((50 - k) / 50) * WEIGHTS.stochastic * 0.3;
      if (k < 50) bullScore += nudge;
      else        bearScore += nudge;
    }
  }

  // ── Bollinger Bands (20, 2σ) ──────────────────────────────────────────────
  // BUY  when price touches / breaks below lower band (mean-reversion up)
  // SELL when price touches / breaks above upper band (mean-reversion down)
  // Also use %B position for a directional nudge in the neutral zone
  const bbResult = bollingerBands(closes, 20, 2);
  if (bbResult) {
    if (bbResult.signal === 'BUY') {
      const contribution = (bbResult.strength / 100) * WEIGHTS.bollinger;
      bullScore += contribution;
      activeIndicators.push('Bollinger Bands');
      notes.push(`Price at lower BB (${bbResult.lower.toFixed(5)})`);
    } else if (bbResult.signal === 'SELL') {
      const contribution = (bbResult.strength / 100) * WEIGHTS.bollinger;
      bearScore += contribution;
      activeIndicators.push('Bollinger Bands');
      notes.push(`Price at upper BB (${bbResult.upper.toFixed(5)})`);
    } else {
      // %B position: 0 = at lower band, 1 = at upper band, 0.5 = middle
      const range = bbResult.upper - bbResult.lower;
      const pctB  = range > 0 ? (currentPrice - bbResult.lower) / range : 0.5;
      const nudge = Math.abs(pctB - 0.5) * WEIGHTS.bollinger * 0.4;
      if (pctB < 0.5) bullScore += nudge; // closer to lower band → lean BUY
      else            bearScore += nudge; // closer to upper band → lean SELL
      notes.push(`BB mid (${bbResult.middle.toFixed(5)})`);
    }
  }

  // ── ATR — block only extreme unpredictable volatility ────────────────────
  const atrValue = atr(highs, lows, closes, 14);
  const atrPct   = atrValue ? (atrValue / currentPrice) * 100 : 0;

  if (atrPct > 3.0) {
    return {
      direction: 'BUY', score: 0, indicators: [],
      notes: 'Extreme volatility — skipped',
      entryPrice: +currentPrice.toFixed(6), atrPct: +atrPct.toFixed(4),
    };
  }

  // ── Final score ───────────────────────────────────────────────────────────
  const direction        = bullScore >= bearScore ? 'BUY' : 'SELL';
  const rawScore         = direction === 'BUY' ? bullScore : bearScore;
  const uniqueIndicators = [...new Set(activeIndicators)];

  // Confluence bonus: more indicators agreeing = higher confidence
  const confluenceBonus = uniqueIndicators.length >= 4 ? 1.20
                        : uniqueIndicators.length >= 3 ? 1.10
                        : uniqueIndicators.length >= 2 ? 1.05
                        : 1.0;

  const score = Math.min(100, Math.round(rawScore * confluenceBonus));

  return {
    direction,
    score,
    indicators: uniqueIndicators,
    notes: notes.join(' | '),
    entryPrice: +currentPrice.toFixed(6),
    atrPct: +atrPct.toFixed(4),
  };
}

// ── Engine ────────────────────────────────────────────────────────────────────

async function run() {
  const symbols = Object.keys(ASSETS);

  // Advance all price series by one candle
  symbols.forEach((s) => tickCandle(s));

  // Score every pair
  const results = symbols.map((symbol) => {
    try {
      return { symbol, ...scorePair(symbol) };
    } catch (err) {
      console.error(`[Engine] Error scoring ${symbol}:`, err.message);
      return null;
    }
  }).filter(Boolean);

  // Pick the pair with the highest score
  results.sort((a, b) => b.score - a.score);
  const best = results[0];

  console.log('[Engine] Scores:', results.map((r) =>
    `${r.symbol}:${r.score}(${r.direction})`
  ).join(' | '));

  if (!best || best.score < MIN_SCORE) {
    console.log(`[Engine] No signal emitted`);
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

  const now        = Date.now();
  const entryTime  = new Date(now + ENTRY_DELAY_SECS * 1000);
  const expiryTime = new Date(now + ENTRY_DELAY_SECS * 1000 + TRADE_DURATION_SECS * 1000);
  const timeframe  = TIMEFRAME_OPTIONS[Math.floor(Math.random() * TIMEFRAME_OPTIONS.length)];

  const signal = await Signal.create({
    asset:       best.symbol,
    direction:   best.direction,
    timeframe,
    entryPrice:  best.entryPrice,
    entryTime,
    expiryTime,
    confidence:  best.score,
    indicators:  best.indicators,
    notes:       best.notes,
    status:      'pending',
    createdBy:   systemUser._id,
    generatedBy: 'engine',
  });

  console.log(
    `[Engine] ✅ ${best.symbol} ${best.direction} ${timeframe} | score=${best.score} | [${best.indicators.join(', ')}]`
  );

  return signal;
}

module.exports = { run, scorePair, ENTRY_DELAY_SECS, TRADE_DURATION_SECS };
