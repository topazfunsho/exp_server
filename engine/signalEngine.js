'use strict';

/**
 * Signal Engine
 *
 * Signal is sent when at least 2 of the 3 indicators agree on direction:
 *   - Stochastic %K: oversold <20 → BUY, overbought >80 → SELL
 *   - RSI:           oversold <30 → BUY, overbought >70 → SELL
 *   - MACD histogram: positive  → BUY, negative         → SELL
 *
 * Any combination of 2 or all 3 agreeing triggers a signal.
 * Confidence score reflects how many agree and how extreme their readings are.
 */

const Signal = require('../models/Signal');
const User   = require('../models/User');
const { fetchCandles, tickCandle, ASSETS } = require('./priceSimulator');
const { rsi, macd, stochastic, atr, bollingerBands } = require('./indicators');

const SIGNAL_TIMEFRAME    = '3m';
const PREP_SECS           = 10;
const TRADE_DURATION_SECS = 3 * 60;
const ENTRY_DELAY_SECS    = PREP_SECS;

// ── Scoring ───────────────────────────────────────────────────────────────────

function scorePair(symbol) {
  const { highs, lows, closes } = fetchCandles(symbol, 200);
  const currentPrice = closes[closes.length - 1];

  const votes   = [];  // { dir: 'BUY'|'SELL', strength: 0-100, label: string, note: string }

  // ── 1. Stochastic %K ──────────────────────────────────────────────────────
  const stochResult = stochastic(highs, lows, closes, 14, 3);
  if (stochResult) {
    const k = stochResult.k;
    if (k <= 20) {
      votes.push({ dir: 'BUY',  strength: Math.min(100, Math.round(((20 - k) / 20) * 100)), label: 'Stochastic', note: `Stoch %K ${k.toFixed(1)} / %D ${stochResult.d.toFixed(1)} (oversold <20)` });
    } else if (k >= 80) {
      votes.push({ dir: 'SELL', strength: Math.min(100, Math.round(((k - 80) / 20) * 100)), label: 'Stochastic', note: `Stoch %K ${k.toFixed(1)} / %D ${stochResult.d.toFixed(1)} (overbought >80)` });
    }
  }

  // ── 2. RSI ────────────────────────────────────────────────────────────────
  const rsiResult = rsi(closes, 14);
  if (rsiResult) {
    const v = rsiResult.value;
    if (v <= 30) {
      votes.push({ dir: 'BUY',  strength: Math.min(100, Math.round(((30 - v) / 30) * 100)), label: 'RSI', note: `RSI ${v.toFixed(1)} (oversold <30)` });
    } else if (v >= 70) {
      votes.push({ dir: 'SELL', strength: Math.min(100, Math.round(((v - 70) / 30) * 100)), label: 'RSI', note: `RSI ${v.toFixed(1)} (overbought >70)` });
    }
  }

  // ── 3. MACD histogram ─────────────────────────────────────────────────────
  const macdResult = macd(closes);
  if (macdResult && macdResult.direction !== 'NEUTRAL') {
    votes.push({ dir: macdResult.direction, strength: Math.min(100, macdResult.strength ?? 50), label: 'MACD', note: `MACD ${macdResult.direction === 'BUY' ? 'bullish' : 'bearish'} (hist ${macdResult.histogram > 0 ? '+' : ''}${macdResult.histogram})` });
  }

  // ── 4. Bollinger Bands ────────────────────────────────────────────────────
  // BUY  when price touches/breaks below lower band (mean-reversion up)
  // SELL when price touches/breaks above upper band (mean-reversion down)
  const bbResult = bollingerBands(closes, 20, 2);
  if (bbResult && bbResult.signal !== 'NEUTRAL') {
    votes.push({ dir: bbResult.signal, strength: Math.min(100, bbResult.strength ?? 50), label: 'Bollinger Bands', note: bbResult.signal === 'BUY' ? `Price at lower BB (${bbResult.lower.toFixed(5)})` : `Price at upper BB (${bbResult.upper.toFixed(5)})` });
  }

  // ── Count agreement ───────────────────────────────────────────────────────
  const buyVotes  = votes.filter((v) => v.dir === 'BUY');
  const sellVotes = votes.filter((v) => v.dir === 'SELL');

  const direction   = buyVotes.length >= sellVotes.length ? 'BUY' : 'SELL';
  const agreeVotes  = direction === 'BUY' ? buyVotes : sellVotes;

  // Need at least 2 indicators agreeing
  if (agreeVotes.length < 2) {
    return {
      direction, score: 0, indicators: [], entryPrice: +currentPrice.toFixed(6),
      notes: `Only ${agreeVotes.length} indicator(s) agree — need at least 2`,
    };
  }

  // ── ATR filter ────────────────────────────────────────────────────────────
  const atrValue = atr(highs, lows, closes, 14);
  const atrPct   = atrValue ? (atrValue / currentPrice) * 100 : 0;
  if (atrPct > 3.0) {
    return { direction, score: 0, indicators: [], entryPrice: +currentPrice.toFixed(6), notes: 'Extreme volatility — skipped' };
  }
  const volMultiplier = atrPct > 1.0 ? 0.90 : 1.0;

  // ── Confidence score ──────────────────────────────────────────────────────
  const avgStrength = agreeVotes.reduce((s, v) => s + v.strength, 0) / agreeVotes.length;
  // All 4 agreeing gets the highest bonus, 3 gets a medium bonus
  const confluenceBonus = agreeVotes.length >= 4 ? 1.30 : agreeVotes.length >= 3 ? 1.20 : 1.0;
  const score = Math.min(100, Math.round((40 + avgStrength * 0.6) * volMultiplier * confluenceBonus));

  return {
    direction,
    score,
    indicators: agreeVotes.map((v) => v.label),
    notes:      agreeVotes.map((v) => v.note).join(' | '),
    entryPrice: +currentPrice.toFixed(6),
    atrPct:     +atrPct.toFixed(4),
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

  // Align entry to the next 3-minute candle boundary on the market clock.
  // e.g. if now = 09:01:45, the next 3m candle opens at 09:03:00
  // We send the signal 10s before that: entryTime = 09:03:00, signal arrives at 09:02:50
  const now              = Date.now();
  const candleMs         = TRADE_DURATION_SECS * 1000;            // 180 000 ms
  const msIntoCandle     = now % candleMs;                        // how far into current candle
  const msUntilNextCandle = candleMs - msIntoCandle;              // ms until next candle opens

  // entryTime  = start of the next 3m candle (market-aligned)
  // signal is delivered PREP_SECS before that so user has time to open the trade
  // expiryTime = entryTime + 3 minutes (end of that candle)
  const entryTime  = new Date(now + msUntilNextCandle);
  const expiryTime = new Date(now + msUntilNextCandle + candleMs);

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
    status:      'pending',
    createdBy:   systemUser._id,
    generatedBy: 'engine',
  });

  // Push the new signal to all connected dashboard clients immediately
  const app = require('../app');
  if (app.locals.broadcastSignal) {
    const populated = await Signal.findById(signal._id).populate('createdBy', 'name').lean();
    app.locals.broadcastSignal(populated);
  }

  console.log(
    `[Engine] ✅ ${best.symbol} ${best.direction} ${SIGNAL_TIMEFRAME} | score=${best.score} | entry in ${PREP_SECS}s | [${best.indicators.join(', ')}]`
  );

  return signal;
}

module.exports = { run, scorePair, ENTRY_DELAY_SECS, TRADE_DURATION_SECS };
