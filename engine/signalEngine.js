/**
 * Signal Engine
 *
 * Every time run() is called it:
 *  1. Ticks all pair prices forward by one candle
 *  2. Runs all technical indicators on each pair
 *  3. Scores each pair (0–100) based on indicator agreement
 *  4. Picks the pair with the highest score (if above MIN_SCORE threshold)
 *  5. Saves the signal to MongoDB and expires the previous active signal for that pair
 *
 * Scoring logic:
 *  - Each indicator votes BUY (+weight) or SELL (-weight) or NEUTRAL (0)
 *  - The raw score is the sum of weighted votes normalised to 0–100
 *  - Direction is determined by the sign of the raw score
 *  - Confidence = normalised absolute score
 */

'use strict';

const Signal = require('../models/Signal');
const User   = require('../models/User');
const { fetchCandles, getCurrentPrice, tickCandle, ASSETS } = require('./priceSimulator');
const { rsi, macd, bollingerBands, stochastic, atr, cci, emaCrossover } = require('./indicators');

// ── Config ────────────────────────────────────────────────────────────────────

const MIN_SCORE        = 45;   // minimum confidence to emit a signal (0–100)
const SIGNAL_TIMEFRAME = '1m'; // ExpertOption 1-minute expiry
const EXPIRY_SECONDS   = 60;   // signal expires in 60 seconds

// Indicator weights (must sum to 100 for clean normalisation)
const WEIGHTS = {
  rsi:          20,
  macd:         20,
  bollinger:    15,
  stochastic:   15,
  cci:          15,
  emaCrossover: 15,
};

// ── Scoring ───────────────────────────────────────────────────────────────────

/**
 * Score a single pair.
 * @returns {{ direction: 'BUY'|'SELL', score: number, indicators: string[], notes: string }}
 */
function scorePair(symbol) {
  const { highs, lows, closes } = fetchCandles(symbol, 200);

  let bullScore = 0;
  let bearScore = 0;
  const activeIndicators = [];
  const notes = [];

  // ── RSI ──────────────────────────────────────────────────────────────────
  const rsiResult = rsi(closes, 14);
  if (rsiResult) {
    const contribution = (rsiResult.strength / 100) * WEIGHTS.rsi;
    if (rsiResult.signal === 'BUY') {
      bullScore += contribution;
      activeIndicators.push('RSI');
      notes.push(`RSI ${rsiResult.value} (oversold)`);
    } else if (rsiResult.signal === 'SELL') {
      bearScore += contribution;
      activeIndicators.push('RSI');
      notes.push(`RSI ${rsiResult.value} (overbought)`);
    }
  }

  // ── MACD ─────────────────────────────────────────────────────────────────
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

  // ── Bollinger Bands ───────────────────────────────────────────────────────
  const bbResult = bollingerBands(closes, 20, 2);
  if (bbResult) {
    const contribution = (bbResult.strength / 100) * WEIGHTS.bollinger;
    if (bbResult.signal === 'BUY') {
      bullScore += contribution;
      activeIndicators.push('Bollinger Bands');
      notes.push(`Price below lower BB (${bbResult.lower.toFixed(5)})`);
    } else if (bbResult.signal === 'SELL') {
      bearScore += contribution;
      activeIndicators.push('Bollinger Bands');
      notes.push(`Price above upper BB (${bbResult.upper.toFixed(5)})`);
    }
  }

  // ── Stochastic ────────────────────────────────────────────────────────────
  const stochResult = stochastic(highs, lows, closes, 14, 3);
  if (stochResult) {
    const contribution = (stochResult.strength / 100) * WEIGHTS.stochastic;
    if (stochResult.signal === 'BUY') {
      bullScore += contribution;
      activeIndicators.push('Stochastic');
      notes.push(`Stoch %K ${stochResult.k} (oversold)`);
    } else if (stochResult.signal === 'SELL') {
      bearScore += contribution;
      activeIndicators.push('Stochastic');
      notes.push(`Stoch %K ${stochResult.k} (overbought)`);
    }
  }

  // ── CCI ───────────────────────────────────────────────────────────────────
  const cciResult = cci(highs, lows, closes, 20);
  if (cciResult) {
    const contribution = (cciResult.strength / 100) * WEIGHTS.cci;
    if (cciResult.signal === 'BUY') {
      bullScore += contribution;
      activeIndicators.push('CCI');
      notes.push(`CCI ${cciResult.value} (oversold)`);
    } else if (cciResult.signal === 'SELL') {
      bearScore += contribution;
      activeIndicators.push('CCI');
      notes.push(`CCI ${cciResult.value} (overbought)`);
    }
  }

  // ── EMA Crossover ─────────────────────────────────────────────────────────
  const emaResult = emaCrossover(closes, 9, 21);
  if (emaResult) {
    const contribution = (emaResult.strength / 100) * WEIGHTS.emaCrossover;
    if (emaResult.signal === 'BUY') {
      bullScore += contribution;
      activeIndicators.push('EMA');
      notes.push(`EMA9 > EMA21 (${emaResult.fast.toFixed(5)} > ${emaResult.slow.toFixed(5)})`);
    } else if (emaResult.signal === 'SELL') {
      bearScore += contribution;
      activeIndicators.push('EMA');
      notes.push(`EMA9 < EMA21 (${emaResult.fast.toFixed(5)} < ${emaResult.slow.toFixed(5)})`);
    }
  }

  // ── ATR (volatility filter) ───────────────────────────────────────────────
  // Low ATR = choppy market, reduce confidence
  const atrValue = atr(highs, lows, closes, 14);
  const currentPrice = closes[closes.length - 1];
  const atrPct = atrValue ? (atrValue / currentPrice) * 100 : 0;
  const volatilityMultiplier = atrPct < 0.01 ? 0.6 : atrPct > 0.5 ? 0.8 : 1.0;

  // ── Final score ───────────────────────────────────────────────────────────
  const direction = bullScore >= bearScore ? 'BUY' : 'SELL';
  const rawScore  = direction === 'BUY' ? bullScore : bearScore;

  // Normalise to 0–100 (max possible raw score = 100 if all indicators agree)
  const score = Math.min(100, Math.round(rawScore * volatilityMultiplier));

  return {
    direction,
    score,
    indicators: [...new Set(activeIndicators)],
    notes: notes.join(' | '),
    entryPrice: +currentPrice.toFixed(6),
    atrPct: +atrPct.toFixed(4),
  };
}

// ── Engine ────────────────────────────────────────────────────────────────────

/**
 * Main engine function — called every minute by the scheduler.
 * @returns {Promise<object|null>} The saved signal document, or null if no signal was strong enough.
 */
async function run() {
  const symbols = Object.keys(ASSETS);

  // Tick all prices forward
  symbols.forEach((s) => tickCandle(s));

  // Score every pair
  const results = symbols.map((symbol) => {
    try {
      const analysis = scorePair(symbol);
      return { symbol, ...analysis };
    } catch (err) {
      console.error(`[Engine] Error scoring ${symbol}:`, err.message);
      return null;
    }
  }).filter(Boolean);

  // Sort by score descending — pick the strongest
  results.sort((a, b) => b.score - a.score);

  const best = results[0];

  console.log('[Engine] Scores:', results.map((r) => `${r.symbol}:${r.score}(${r.direction})`).join(' | '));

  if (!best || best.score < MIN_SCORE) {
    console.log(`[Engine] No signal strong enough (best: ${best?.score ?? 0} < ${MIN_SCORE})`);
    return null;
  }

  // Find or create the system admin user that owns auto-generated signals
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

  // Expire any still-active signals for this pair
  await Signal.updateMany(
    { asset: best.symbol, status: 'active' },
    { $set: { status: 'expired' } }
  );

  const expiryTime = new Date(Date.now() + EXPIRY_SECONDS * 1000);

  const signal = await Signal.create({
    asset:      best.symbol,
    direction:  best.direction,
    timeframe:  SIGNAL_TIMEFRAME,
    entryPrice: best.entryPrice,
    expiryTime,
    confidence: best.score,
    indicators: best.indicators,
    notes:      best.notes,
    status:     'active',
    createdBy:  systemUser._id,
    generatedBy: 'engine',
  });

  console.log(
    `[Engine] ✅ Signal: ${best.symbol} ${best.direction} | score=${best.score} | indicators=[${best.indicators.join(',')}]`
  );

  return signal;
}

module.exports = { run, scorePair };
