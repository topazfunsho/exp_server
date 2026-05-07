/**
 * Price Simulator
 *
 * Generates realistic OHLCV candle history for each trading pair.
 *
 * Key improvement for signal quality:
 *  - Mean-reversion tendency: when price drifts far from its moving average,
 *    it has a higher probability of reverting. This is what makes RSI/BB/Stoch
 *    signals actually profitable — oversold conditions genuinely tend to bounce.
 *  - Momentum persistence: recent trend has a small carry-forward effect,
 *    so EMA crossovers and MACD signals have follow-through.
 *
 * In production replace fetchCandles() with a real market data provider.
 */

'use strict';

const ASSETS = {
  'EUR/USD': { basePrice: 1.0850, volatility: 0.0008 },
  'GBP/USD': { basePrice: 1.2700, volatility: 0.0010 },
  'USD/JPY': { basePrice: 149.50, volatility: 0.0009 },
  'AUD/USD': { basePrice: 0.6550, volatility: 0.0009 },
  'USD/CAD': { basePrice: 1.3600, volatility: 0.0008 },
  'EUR/GBP': { basePrice: 0.8550, volatility: 0.0006 },
  'USD/CHF': { basePrice: 0.9050, volatility: 0.0007 },
  'NZD/USD': { basePrice: 0.6100, volatility: 0.0009 },
  'BTC/USD': { basePrice: 67000,  volatility: 0.0200 },
  'ETH/USD': { basePrice: 3500,   volatility: 0.0180 },
  'XAU/USD': { basePrice: 2350,   volatility: 0.0060 },
  'OIL/USD': { basePrice: 82.00,  volatility: 0.0120 },
};

const priceState = {};

// Seeded PRNG (Mulberry32) — reproducible per asset
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller: uniform → normal
function normalRandom(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// Simple moving average of last N values
function simpleMA(arr, n) {
  const slice = arr.slice(-n);
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}

function getOrInitState(symbol) {
  if (priceState[symbol]) return priceState[symbol];

  const { basePrice, volatility } = ASSETS[symbol];
  const seed = symbol.split('').reduce((s, c) => s + c.charCodeAt(0), 0);
  const rand = mulberry32(seed);

  const candles = [];
  let price = basePrice;
  let momentum = 0; // carry-forward momentum

  for (let i = 0; i < 300; i++) {
    // Mean-reversion: pull price back toward 20-bar MA when it drifts
    const ma20 = candles.length >= 20
      ? simpleMA(candles.slice(-20).map((c) => c.close), 20)
      : basePrice;
    const deviation = (price - ma20) / ma20;
    // Reversion force proportional to how far price has drifted
    const reversionForce = -deviation * 0.35;

    // Momentum persistence (small carry-forward from last move)
    momentum = momentum * 0.3 + normalRandom(rand) * volatility;

    const move = price * (momentum + reversionForce * volatility);
    const open  = price;
    const close = Math.max(price * 0.5, price + move);
    const high  = Math.max(open, close) * (1 + rand() * volatility * 0.4);
    const low   = Math.min(open, close) * (1 - rand() * volatility * 0.4);
    const volume = Math.round(1000 + rand() * 9000);

    candles.push({ open, high, low, close, volume });
    price = close;
  }

  priceState[symbol] = { candles, rand, volatility, momentum };
  return priceState[symbol];
}

function tickCandle(symbol) {
  const state = getOrInitState(symbol);
  const { rand, volatility } = state;
  const closes = state.candles.map((c) => c.close);
  const prevClose = closes[closes.length - 1];

  // Mean-reversion toward 20-bar MA
  const ma20 = simpleMA(closes.slice(-20), 20);
  const deviation = (prevClose - ma20) / ma20;
  const reversionForce = -deviation * 0.35;

  // Momentum persistence
  state.momentum = state.momentum * 0.3 + normalRandom(rand) * volatility;

  const move  = prevClose * (state.momentum + reversionForce * volatility);
  const open  = prevClose;
  const close = Math.max(prevClose * 0.5, prevClose + move);
  const high  = Math.max(open, close) * (1 + rand() * volatility * 0.4);
  const low   = Math.min(open, close) * (1 - rand() * volatility * 0.4);
  const volume = Math.round(1000 + rand() * 9000);

  state.candles.push({ open, high, low, close, volume });
  if (state.candles.length > 400) state.candles.shift();

  return { open, high, low, close, volume };
}

function fetchCandles(symbol, count = 200) {
  const state = getOrInitState(symbol);
  const slice = state.candles.slice(-count);
  return {
    opens:   slice.map((c) => c.open),
    highs:   slice.map((c) => c.high),
    lows:    slice.map((c) => c.low),
    closes:  slice.map((c) => c.close),
    volumes: slice.map((c) => c.volume),
  };
}

function getCurrentPrice(symbol) {
  const state = getOrInitState(symbol);
  return state.candles[state.candles.length - 1].close;
}

module.exports = { ASSETS, fetchCandles, getCurrentPrice, tickCandle };
