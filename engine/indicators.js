/**
 * Technical indicator calculations (pure math, no external deps)
 * All functions accept an array of closing prices (most recent LAST)
 * unless otherwise noted.
 */

'use strict';

// ── Helpers ───────────────────────────────────────────────────────────────────

const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;

/**
 * Simple Moving Average
 * @param {number[]} prices
 * @param {number} period
 * @returns {number}
 */
function sma(prices, period) {
  if (prices.length < period) return null;
  return avg(prices.slice(-period));
}

/**
 * Exponential Moving Average
 * @param {number[]} prices
 * @param {number} period
 * @returns {number}
 */
function ema(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let result = avg(prices.slice(0, period));
  for (let i = period; i < prices.length; i++) {
    result = prices[i] * k + result * (1 - k);
  }
  return result;
}

/**
 * Relative Strength Index
 * @param {number[]} prices
 * @param {number} period  default 14
 * @returns {{ value: number, signal: 'BUY'|'SELL'|'NEUTRAL', strength: number }}
 */
function rsi(prices, period = 14) {
  if (prices.length < period + 1) return null;

  const changes = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }

  const recent = changes.slice(-period);
  const gains = recent.map((c) => (c > 0 ? c : 0));
  const losses = recent.map((c) => (c < 0 ? -c : 0));

  const avgGain = avg(gains);
  const avgLoss = avg(losses);

  if (avgLoss === 0) return { value: 100, signal: 'SELL', strength: 100 };

  const rs = avgGain / avgLoss;
  const value = 100 - 100 / (1 + rs);

  let signal = 'NEUTRAL';
  let strength = 0;

  if (value <= 30) {
    signal = 'BUY';
    strength = Math.round(((30 - value) / 30) * 100); // 0–100
  } else if (value >= 70) {
    signal = 'SELL';
    strength = Math.round(((value - 70) / 30) * 100);
  }

  return { value: +value.toFixed(2), signal, strength };
}

/**
 * MACD (12, 26, 9)
 * @param {number[]} prices
 * @returns {{ macd: number, signal: number, histogram: number, direction: 'BUY'|'SELL'|'NEUTRAL', strength: number }}
 */
function macd(prices, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (prices.length < slowPeriod + signalPeriod) return null;

  // Build MACD line values over time
  const macdLine = [];
  for (let i = slowPeriod - 1; i < prices.length; i++) {
    const slice = prices.slice(0, i + 1);
    const fast = ema(slice, fastPeriod);
    const slow = ema(slice, slowPeriod);
    if (fast !== null && slow !== null) macdLine.push(fast - slow);
  }

  if (macdLine.length < signalPeriod) return null;

  const signalLine = ema(macdLine, signalPeriod);
  const currentMacd = macdLine[macdLine.length - 1];
  const histogram = currentMacd - signalLine;

  // Crossover detection: compare last two histogram values
  const prevHistogram =
    macdLine.length >= signalPeriod + 1
      ? macdLine[macdLine.length - 2] - ema(macdLine.slice(0, -1), signalPeriod)
      : 0;

  let direction = 'NEUTRAL';
  let strength = Math.min(100, Math.round(Math.abs(histogram) * 10000));

  if (histogram > 0 && prevHistogram <= 0) {
    direction = 'BUY'; // bullish crossover
  } else if (histogram < 0 && prevHistogram >= 0) {
    direction = 'SELL'; // bearish crossover
  } else if (histogram > 0) {
    direction = 'BUY';
  } else if (histogram < 0) {
    direction = 'SELL';
  }

  return {
    macd: +currentMacd.toFixed(6),
    signal: +signalLine.toFixed(6),
    histogram: +histogram.toFixed(6),
    direction,
    strength,
  };
}

/**
 * Bollinger Bands
 * @param {number[]} prices
 * @param {number} period  default 20
 * @param {number} stdDev  default 2
 * @returns {{ upper: number, middle: number, lower: number, bandwidth: number, signal: 'BUY'|'SELL'|'NEUTRAL', strength: number }}
 */
function bollingerBands(prices, period = 20, stdDev = 2) {
  if (prices.length < period) return null;

  const slice = prices.slice(-period);
  const middle = avg(slice);
  const variance = slice.reduce((s, v) => s + Math.pow(v - middle, 2), 0) / period;
  const sd = Math.sqrt(variance);

  const upper = middle + stdDev * sd;
  const lower = middle - stdDev * sd;
  const bandwidth = ((upper - lower) / middle) * 100;
  const current = prices[prices.length - 1];

  let signal = 'NEUTRAL';
  let strength = 0;

  if (current <= lower) {
    signal = 'BUY';
    strength = Math.min(100, Math.round(((lower - current) / sd) * 50));
  } else if (current >= upper) {
    signal = 'SELL';
    strength = Math.min(100, Math.round(((current - upper) / sd) * 50));
  }

  return {
    upper: +upper.toFixed(6),
    middle: +middle.toFixed(6),
    lower: +lower.toFixed(6),
    bandwidth: +bandwidth.toFixed(2),
    signal,
    strength,
  };
}

/**
 * Stochastic Oscillator (%K, %D)
 * @param {number[]} highs
 * @param {number[]} lows
 * @param {number[]} closes
 * @param {number} kPeriod  default 14
 * @param {number} dPeriod  default 3
 * @returns {{ k: number, d: number, signal: 'BUY'|'SELL'|'NEUTRAL', strength: number }}
 */
function stochastic(highs, lows, closes, kPeriod = 14, dPeriod = 3) {
  if (closes.length < kPeriod + dPeriod) return null;

  const kValues = [];
  for (let i = kPeriod - 1; i < closes.length; i++) {
    const highSlice = highs.slice(i - kPeriod + 1, i + 1);
    const lowSlice = lows.slice(i - kPeriod + 1, i + 1);
    const highestHigh = Math.max(...highSlice);
    const lowestLow = Math.min(...lowSlice);
    const range = highestHigh - lowestLow;
    kValues.push(range === 0 ? 50 : ((closes[i] - lowestLow) / range) * 100);
  }

  const k = kValues[kValues.length - 1];
  const d = avg(kValues.slice(-dPeriod));

  let signal = 'NEUTRAL';
  let strength = 0;

  if (k < 20 && d < 20) {
    signal = 'BUY';
    strength = Math.round(((20 - k) / 20) * 100);
  } else if (k > 80 && d > 80) {
    signal = 'SELL';
    strength = Math.round(((k - 80) / 20) * 100);
  }

  return { k: +k.toFixed(2), d: +d.toFixed(2), signal, strength };
}

/**
 * Average True Range (volatility measure)
 * @param {number[]} highs
 * @param {number[]} lows
 * @param {number[]} closes
 * @param {number} period  default 14
 * @returns {number}
 */
function atr(highs, lows, closes, period = 14) {
  if (closes.length < period + 1) return null;

  const trValues = [];
  for (let i = 1; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trValues.push(tr);
  }

  return +avg(trValues.slice(-period)).toFixed(6);
}

/**
 * Commodity Channel Index
 * @param {number[]} highs
 * @param {number[]} lows
 * @param {number[]} closes
 * @param {number} period  default 20
 * @returns {{ value: number, signal: 'BUY'|'SELL'|'NEUTRAL', strength: number }}
 */
function cci(highs, lows, closes, period = 20) {
  if (closes.length < period) return null;

  const typicalPrices = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
  const slice = typicalPrices.slice(-period);
  const mean = avg(slice);
  const meanDeviation = avg(slice.map((v) => Math.abs(v - mean)));

  if (meanDeviation === 0) return { value: 0, signal: 'NEUTRAL', strength: 0 };

  const value = (slice[slice.length - 1] - mean) / (0.015 * meanDeviation);

  let signal = 'NEUTRAL';
  let strength = 0;

  if (value <= -100) {
    signal = 'BUY';
    strength = Math.min(100, Math.round(Math.abs(value + 100) / 2));
  } else if (value >= 100) {
    signal = 'SELL';
    strength = Math.min(100, Math.round((value - 100) / 2));
  }

  return { value: +value.toFixed(2), signal, strength };
}

/**
 * EMA crossover (fast vs slow)
 * @param {number[]} prices
 * @param {number} fast  default 9
 * @param {number} slow  default 21
 * @returns {{ fast: number, slow: number, signal: 'BUY'|'SELL'|'NEUTRAL', strength: number }}
 */
function emaCrossover(prices, fast = 9, slow = 21) {
  if (prices.length < slow + 1) return null;

  const fastEma = ema(prices, fast);
  const slowEma = ema(prices, slow);

  // Previous bar EMAs
  const prevFast = ema(prices.slice(0, -1), fast);
  const prevSlow = ema(prices.slice(0, -1), slow);

  if (!fastEma || !slowEma || !prevFast || !prevSlow) return null;

  const diff = fastEma - slowEma;
  const prevDiff = prevFast - prevSlow;

  let signal = 'NEUTRAL';
  let strength = Math.min(100, Math.round(Math.abs(diff / slowEma) * 10000));

  if (diff > 0 && prevDiff <= 0) {
    signal = 'BUY'; // golden cross
    strength = Math.min(100, strength + 30);
  } else if (diff < 0 && prevDiff >= 0) {
    signal = 'SELL'; // death cross
    strength = Math.min(100, strength + 30);
  } else if (diff > 0) {
    signal = 'BUY';
  } else if (diff < 0) {
    signal = 'SELL';
  }

  return { fast: +fastEma.toFixed(6), slow: +slowEma.toFixed(6), signal, strength };
}

module.exports = { sma, ema, rsi, macd, bollingerBands, stochastic, atr, cci, emaCrossover };
