/**
 * Price Simulator
 *
 * Generates realistic OHLCV candle history for each trading pair.
 * Uses a seeded random walk with volatility profiles per asset class.
 *
 * In production you would replace fetchCandles() with a real market
 * data provider (e.g. Twelve Data, Alpha Vantage, Binance WS, etc.)
 * The rest of the engine (indicators + scoring) stays identical.
 */

'use strict';

// ── Asset definitions ─────────────────────────────────────────────────────────
// basePrice: approximate real-world price
// volatility: daily % move (used to scale per-candle noise)
// trend: slight directional bias (-1 to +1)

const ASSETS = {
  'EUR/USD':  { basePrice: 1.0850,  volatility: 0.0008, trend:  0.0 },
  'GBP/USD':  { basePrice: 1.2700,  volatility: 0.0010, trend:  0.0 },
  'USD/JPY':  { basePrice: 149.50,  volatility: 0.0009, trend:  0.0 },
  'AUD/USD':  { basePrice: 0.6550,  volatility: 0.0009, trend:  0.0 },
  'USD/CAD':  { basePrice: 1.3600,  volatility: 0.0008, trend:  0.0 },
  'EUR/GBP':  { basePrice: 0.8550,  volatility: 0.0006, trend:  0.0 },
  'USD/CHF':  { basePrice: 0.9050,  volatility: 0.0007, trend:  0.0 },
  'NZD/USD':  { basePrice: 0.6100,  volatility: 0.0009, trend:  0.0 },
  'BTC/USD':  { basePrice: 67000,   volatility: 0.0200, trend:  0.0 },
  'ETH/USD':  { basePrice: 3500,    volatility: 0.0180, trend:  0.0 },
  'XAU/USD':  { basePrice: 2350,    volatility: 0.0060, trend:  0.0 }, // Gold
  'OIL/USD':  { basePrice: 82.00,   volatility: 0.0120, trend:  0.0 }, // Crude Oil
};

// In-memory price state per asset (persists across calls within the process)
const priceState = {};

/**
 * Seeded pseudo-random number generator (Mulberry32)
 * Gives reproducible sequences per asset so candles are consistent
 * across multiple calls in the same minute.
 */
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Box-Muller transform: uniform → normal distribution
 */
function normalRandom(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/**
 * Generate or retrieve the current price state for an asset.
 * Initialises with a warm-up walk so indicators have enough history.
 */
function getOrInitState(symbol) {
  if (priceState[symbol]) return priceState[symbol];

  const { basePrice, volatility, trend } = ASSETS[symbol];
  // Seed based on symbol name so each asset has its own random stream
  const seed = symbol.split('').reduce((s, c) => s + c.charCodeAt(0), 0);
  const rand = mulberry32(seed);

  // Build 200 warm-up candles (1-minute each)
  const candles = [];
  let price = basePrice;

  for (let i = 0; i < 200; i++) {
    const move = normalRandom(rand) * volatility * price + trend * volatility * price * 0.1;
    const open = price;
    const close = Math.max(price * 0.5, price + move); // floor at 50% of base
    const high = Math.max(open, close) * (1 + rand() * volatility * 0.5);
    const low = Math.min(open, close) * (1 - rand() * volatility * 0.5);
    const volume = Math.round(1000 + rand() * 9000);

    candles.push({ open, high, low, close, volume });
    price = close;
  }

  priceState[symbol] = { candles, rand, volatility, trend, basePrice };
  return priceState[symbol];
}

/**
 * Advance the price by one candle (called each minute by the scheduler).
 */
function tickCandle(symbol) {
  const state = getOrInitState(symbol);
  const { rand, volatility, trend } = state;
  const prevClose = state.candles[state.candles.length - 1].close;

  const move = normalRandom(rand) * volatility * prevClose + trend * volatility * prevClose * 0.1;
  const open = prevClose;
  const close = Math.max(prevClose * 0.5, prevClose + move);
  const high = Math.max(open, close) * (1 + rand() * volatility * 0.5);
  const low = Math.min(open, close) * (1 - rand() * volatility * 0.5);
  const volume = Math.round(1000 + rand() * 9000);

  state.candles.push({ open, high, low, close, volume });

  // Keep only last 300 candles to avoid unbounded memory growth
  if (state.candles.length > 300) state.candles.shift();

  return { open, high, low, close, volume };
}

/**
 * Return the last N candles for a symbol (initialises if needed).
 * @param {string} symbol
 * @param {number} count  default 200
 * @returns {{ opens: number[], highs: number[], lows: number[], closes: number[], volumes: number[] }}
 */
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

/**
 * Get the current (latest) price for a symbol.
 */
function getCurrentPrice(symbol) {
  const state = getOrInitState(symbol);
  return state.candles[state.candles.length - 1].close;
}

module.exports = { ASSETS, fetchCandles, getCurrentPrice, tickCandle };
