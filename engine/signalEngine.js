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
const { fetchCandles, tickCandle, ASSETS } = require('./priceSimulator');
const { rsi, macd, bollingerBands, stochastic, atr, cci, emaCrossover } = require('./indicators');

// ── Config ────────────────────────────────────────────────────────────────────

const MIN_SCORE          = 20;
const SIGNAL_TIMEFRAME   = '1m';
const ENTRY_DELAY_SECS   = 60;   // user has 60s to prepare before entry opens
const TRADE_DURATION_SECS = 60;  // trade lasts 60s after entry opens

const BASE_SCORE = 30;

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
  // Relaxed: was <30/>70 (strong only). Now <40/>60 catches medium setups.
  const rsiResult = rsi(closes, 14);
  if (rsiResult) {
    const currentRsi = rsiResult.value;
    let rsiSignal = 'NEUTRAL';
    let rsiStrength = 0;

    if (currentRsi < 40) {
      rsiSignal = 'BUY';
      // Scale: RSI 40 → strength 0, RSI 20 → strength 100
      rsiStrength = Math.min(100, Math.round(((40 - currentRsi) / 40) * 100));
    } else if (currentRsi > 60) {
      rsiSignal = 'SELL';
      rsiStrength = Math.min(100, Math.round(((currentRsi - 60) / 40) * 100));
    }

    if (rsiSignal !== 'NEUTRAL') {
      const contribution = (rsiStrength / 100) * WEIGHTS.rsi;
      if (rsiSignal === 'BUY') {
        bullScore += contribution;
        activeIndicators.push('RSI');
        notes.push(`RSI ${currentRsi} (${currentRsi < 30 ? 'oversold' : 'bearish zone'})`);
      } else {
        bearScore += contribution;
        activeIndicators.push('RSI');
        notes.push(`RSI ${currentRsi} (${currentRsi > 70 ? 'overbought' : 'bullish zone'})`);
      }
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
  // Relaxed: was <20/>80. Now <30/>70 catches medium momentum.
  const stochResult = stochastic(highs, lows, closes, 14, 3);
  if (stochResult) {
    let stochSignal = 'NEUTRAL';
    let stochStrength = 0;

    if (stochResult.k < 30) {
      stochSignal = 'BUY';
      stochStrength = Math.min(100, Math.round(((30 - stochResult.k) / 30) * 100));
    } else if (stochResult.k > 70) {
      stochSignal = 'SELL';
      stochStrength = Math.min(100, Math.round(((stochResult.k - 70) / 30) * 100));
    }

    if (stochSignal !== 'NEUTRAL') {
      const contribution = (stochStrength / 100) * WEIGHTS.stochastic;
      if (stochSignal === 'BUY') {
        bullScore += contribution;
        activeIndicators.push('Stochastic');
        notes.push(`Stoch %K ${stochResult.k} (${stochResult.k < 20 ? 'oversold' : 'low momentum'})`);
      } else {
        bearScore += contribution;
        activeIndicators.push('Stochastic');
        notes.push(`Stoch %K ${stochResult.k} (${stochResult.k > 80 ? 'overbought' : 'high momentum'})`);
      }
    }
  }

  // ── CCI ───────────────────────────────────────────────────────────────────
  // Relaxed: was ±100. Now ±75 catches medium-strength momentum.
  const cciResult = cci(highs, lows, closes, 20);
  if (cciResult) {
    let cciSignal = 'NEUTRAL';
    let cciStrength = 0;

    if (cciResult.value <= -75) {
      cciSignal = 'BUY';
      cciStrength = Math.min(100, Math.round(Math.abs(cciResult.value + 75) / 1.5));
    } else if (cciResult.value >= 75) {
      cciSignal = 'SELL';
      cciStrength = Math.min(100, Math.round((cciResult.value - 75) / 1.5));
    }

    if (cciSignal !== 'NEUTRAL') {
      const contribution = (cciStrength / 100) * WEIGHTS.cci;
      if (cciSignal === 'BUY') {
        bullScore += contribution;
        activeIndicators.push('CCI');
        notes.push(`CCI ${cciResult.value} (${cciResult.value <= -100 ? 'oversold' : 'bearish pressure'})`);
      } else {
        bearScore += contribution;
        activeIndicators.push('CCI');
        notes.push(`CCI ${cciResult.value} (${cciResult.value >= 100 ? 'overbought' : 'bullish pressure'})`);
      }
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
  // Raised floor from 0.6 → 0.85 so calm markets don't kill the score.
  // Extremely high volatility (>1%) still gets a slight penalty.
  const atrValue = atr(highs, lows, closes, 14);
  const currentPrice = closes[closes.length - 1];
  const atrPct = atrValue ? (atrValue / currentPrice) * 100 : 0;
  const volatilityMultiplier = atrPct < 0.005 ? 0.85 : atrPct > 1.0 ? 0.90 : 1.0;

  // ── Final score ───────────────────────────────────────────────────────────
  const direction = bullScore >= bearScore ? 'BUY' : 'SELL';
  const rawScore  = direction === 'BUY' ? bullScore : bearScore;

  // Add BASE_SCORE so even 1–2 agreeing indicators produce a visible
  // medium-range confidence (35–65) rather than near-zero values.
  const score = Math.min(100, Math.round(BASE_SCORE + rawScore * volatilityMultiplier));

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

  // Expire any still-pending/active signals for this pair
  await Signal.updateMany(
    { asset: best.symbol, status: { $in: ['pending', 'active'] } },
    { $set: { status: 'skipped' } }
  );

  const now        = Date.now();
  const entryTime  = new Date(now + ENTRY_DELAY_SECS * 1000);
  const expiryTime = new Date(now + ENTRY_DELAY_SECS * 1000 + TRADE_DURATION_SECS * 1000);

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
    status:      'pending',   // pending until entryTime is reached
    createdBy:   systemUser._id,
    generatedBy: 'engine',
  });

  console.log(
    `[Engine] ✅ Signal: ${best.symbol} ${best.direction} | score=${best.score} | indicators=[${best.indicators.join(',')}]`
  );

  return signal;
}

module.exports = { run, scorePair };
