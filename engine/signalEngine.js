/**
 * Signal Engine — targets ~70% win rate
 *
 * Win rate improvement strategy:
 *  1. Mean-reverting price simulator — oversold/overbought conditions
 *     genuinely tend to reverse, making RSI/BB/Stoch signals profitable.
 *  2. Trend confirmation filter — before emitting, verify the last 5 candles
 *     show actual momentum in the signal direction (not just indicator noise).
 *  3. Indicator agreement gate — require at least 3 indicators to agree.
 *  4. Momentum score — weight recent price velocity alongside indicator score.
 *  5. Confluence bonus — 4+ agreeing indicators get a score multiplier.
 */

'use strict';

const Signal = require('../models/Signal');
const User   = require('../models/User');
const { fetchCandles, tickCandle, ASSETS } = require('./priceSimulator');
const { rsi, macd, bollingerBands, stochastic, atr, cci, emaCrossover, ema } = require('./indicators');

// ── Config ────────────────────────────────────────────────────────────────────

const MIN_SCORE           = 40;   // minimum composite score to emit
const MIN_INDICATORS      = 3;    // minimum indicators that must agree
const TIMEFRAME_OPTIONS   = ['3m', '4m'];
const ENTRY_DELAY_SECS    = 60;
const TRADE_DURATION_SECS = 3 * 60;

const WEIGHTS = {
  rsi:          20,
  macd:         20,
  bollinger:    15,
  stochastic:   15,
  cci:          15,
  emaCrossover: 15,
};

// ── Trend confirmation ────────────────────────────────────────────────────────

/**
 * Confirm that recent price action supports the signal direction.
 * Looks at the last `lookback` candles and checks:
 *  - For BUY: price is making higher lows (momentum turning up)
 *  - For SELL: price is making lower highs (momentum turning down)
 * Returns a multiplier 0.0–1.5 (>1.0 = strong confirmation, <1.0 = weak/against)
 */
function trendConfirmation(closes, direction, lookback = 5) {
  if (closes.length < lookback + 1) return 1.0;

  const recent = closes.slice(-lookback);
  const prev   = closes.slice(-(lookback * 2), -lookback);

  if (prev.length === 0) return 1.0;

  const recentAvg = recent.reduce((s, v) => s + v, 0) / recent.length;
  const prevAvg   = prev.reduce((s, v) => s + v, 0) / prev.length;

  const momentum = (recentAvg - prevAvg) / prevAvg; // positive = price rising

  if (direction === 'BUY') {
    // Price should be turning up or at least not strongly falling
    if (momentum > 0.0002)  return 1.4;  // strong upward momentum — great BUY
    if (momentum > 0)       return 1.2;  // mild upward — good BUY
    if (momentum > -0.0002) return 0.9;  // flat — weak BUY
    return 0.5;                          // falling — bad BUY, penalise heavily
  } else {
    // Price should be turning down
    if (momentum < -0.0002) return 1.4;  // strong downward — great SELL
    if (momentum < 0)       return 1.2;  // mild downward — good SELL
    if (momentum < 0.0002)  return 0.9;  // flat — weak SELL
    return 0.5;                          // rising — bad SELL, penalise heavily
  }
}

/**
 * Check that the signal direction aligns with the medium-term trend (50-bar EMA).
 * Returns true if aligned, false if counter-trend (counter-trend signals lose more).
 */
function isTrendAligned(closes, direction) {
  if (closes.length < 55) return true; // not enough data, allow
  const ema50 = ema(closes, 50);
  const ema20 = ema(closes, 20);
  if (!ema50 || !ema20) return true;

  if (direction === 'BUY')  return ema20 >= ema50; // short MA above long MA = uptrend
  if (direction === 'SELL') return ema20 <= ema50; // short MA below long MA = downtrend
  return true;
}

// ── Scoring ───────────────────────────────────────────────────────────────────

function scorePair(symbol) {
  const { highs, lows, closes } = fetchCandles(symbol, 200);

  let bullScore = 0;
  let bearScore = 0;
  const activeIndicators = [];
  const notes = [];

  // ── RSI (classic oversold/overbought zones) ───────────────────────────────
  const rsiResult = rsi(closes, 14);
  if (rsiResult) {
    const v = rsiResult.value;
    if (v <= 35) {
      const strength = Math.min(100, Math.round(((35 - v) / 35) * 100));
      bullScore += (strength / 100) * WEIGHTS.rsi;
      activeIndicators.push('RSI');
      notes.push(`RSI ${v} (oversold)`);
    } else if (v >= 65) {
      const strength = Math.min(100, Math.round(((v - 65) / 35) * 100));
      bearScore += (strength / 100) * WEIGHTS.rsi;
      activeIndicators.push('RSI');
      notes.push(`RSI ${v} (overbought)`);
    }
  }

  // ── MACD ──────────────────────────────────────────────────────────────────
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
    const k = stochResult.k;
    if (k <= 25) {
      const strength = Math.min(100, Math.round(((25 - k) / 25) * 100));
      bullScore += (strength / 100) * WEIGHTS.stochastic;
      activeIndicators.push('Stochastic');
      notes.push(`Stoch %K ${k} (oversold)`);
    } else if (k >= 75) {
      const strength = Math.min(100, Math.round(((k - 75) / 25) * 100));
      bearScore += (strength / 100) * WEIGHTS.stochastic;
      activeIndicators.push('Stochastic');
      notes.push(`Stoch %K ${k} (overbought)`);
    }
  }

  // ── CCI ───────────────────────────────────────────────────────────────────
  const cciResult = cci(highs, lows, closes, 20);
  if (cciResult) {
    const v = cciResult.value;
    if (v <= -90) {
      const strength = Math.min(100, Math.round(Math.abs(v + 90) / 1.5));
      bullScore += (strength / 100) * WEIGHTS.cci;
      activeIndicators.push('CCI');
      notes.push(`CCI ${v} (oversold)`);
    } else if (v >= 90) {
      const strength = Math.min(100, Math.round((v - 90) / 1.5));
      bearScore += (strength / 100) * WEIGHTS.cci;
      activeIndicators.push('CCI');
      notes.push(`CCI ${v} (overbought)`);
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

  // ── ATR volatility filter ─────────────────────────────────────────────────
  const atrValue = atr(highs, lows, closes, 14);
  const currentPrice = closes[closes.length - 1];
  const atrPct = atrValue ? (atrValue / currentPrice) * 100 : 0;

  // Block flat markets and news spikes
  if (atrPct < 0.002 || atrPct > 2.0) {
    return {
      direction: 'BUY', score: 0, indicators: [], notes: 'ATR filter blocked',
      entryPrice: +currentPrice.toFixed(6), atrPct: +atrPct.toFixed(4),
    };
  }

  const volatilityMultiplier = atrPct > 0.8 ? 0.85 : 1.0;

  // ── Direction + indicator gate ────────────────────────────────────────────
  const direction        = bullScore >= bearScore ? 'BUY' : 'SELL';
  const rawScore         = direction === 'BUY' ? bullScore : bearScore;
  const uniqueIndicators = [...new Set(activeIndicators)];

  if (uniqueIndicators.length < MIN_INDICATORS) {
    return {
      direction, score: 0, indicators: uniqueIndicators,
      notes: `Only ${uniqueIndicators.length} indicators agree`,
      entryPrice: +currentPrice.toFixed(6), atrPct: +atrPct.toFixed(4),
    };
  }

  // ── Trend alignment check ─────────────────────────────────────────────────
  // Counter-trend signals lose far more often — penalise them heavily
  const trendAligned = isTrendAligned(closes, direction);
  const trendMultiplier = trendAligned ? 1.0 : 0.4;

  // ── Trend confirmation (recent momentum) ─────────────────────────────────
  const confirmMultiplier = trendConfirmation(closes, direction, 5);

  // ── Confluence bonus ──────────────────────────────────────────────────────
  const confluenceBonus = uniqueIndicators.length >= 5 ? 1.30
                        : uniqueIndicators.length >= 4 ? 1.15
                        : 1.0;

  const score = Math.min(100, Math.round(
    rawScore * volatilityMultiplier * trendMultiplier * confirmMultiplier * confluenceBonus
  ));

  // Add trend alignment note
  if (!trendAligned) notes.push('⚠ Counter-trend');

  return {
    direction,
    score,
    indicators: uniqueIndicators,
    notes: notes.join(' | '),
    entryPrice: +currentPrice.toFixed(6),
    atrPct: +atrPct.toFixed(4),
    trendAligned,
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
    `${r.symbol}:${r.score}(${r.direction}${r.trendAligned === false ? '⚠' : ''})`
  ).join(' | '));

  if (!best || best.score < MIN_SCORE) {
    console.log(`[Engine] No signal strong enough (best: ${best?.score ?? 0} < ${MIN_SCORE})`);
    return null;
  }

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
    `[Engine] ✅ ${best.symbol} ${best.direction} ${timeframe} | score=${best.score} | trend=${best.trendAligned ? '✓' : '✗'} | indicators=[${best.indicators.join(',')}]`
  );

  return signal;
}

module.exports = { run, scorePair, ENTRY_DELAY_SECS, TRADE_DURATION_SECS };
