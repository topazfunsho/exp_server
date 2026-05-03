const mongoose = require('mongoose');

const signalSchema = new mongoose.Schema(
  {
    asset: {
      type: String,
      required: [true, 'Asset is required'],
      trim: true,
      // e.g. EUR/USD, BTC/USD, Gold, Apple
    },
    direction: {
      type: String,
      enum: ['BUY', 'SELL'],
      required: [true, 'Direction (BUY/SELL) is required'],
    },
    timeframe: {
      type: String,
      enum: ['30s', '1m', '2m', '5m', '15m', '30m', '1h'],
      required: [true, 'Timeframe is required'],
    },
    entryPrice: {
      type: Number,
      required: [true, 'Entry price is required'],
    },
    expiryTime: {
      // Exact datetime when the trade expires
      type: Date,
      required: [true, 'Expiry time is required'],
    },
    confidence: {
      // Analyst confidence score 0–100
      type: Number,
      min: 0,
      max: 100,
      default: 70,
    },
    indicators: {
      // Supporting technical indicators used
      type: [String],
      default: [],
      // e.g. ['RSI', 'MACD', 'Bollinger Bands']
    },
    notes: {
      type: String,
      trim: true,
      default: '',
    },
    status: {
      type: String,
      enum: ['active', 'expired', 'won', 'lost'],
      default: 'active',
    },
    result: {
      // Filled after expiry: actual outcome
      type: String,
      enum: ['win', 'loss', 'draw', null],
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { timestamps: true }
);

// Auto-expire signals past their expiryTime
signalSchema.index({ expiryTime: 1 });

module.exports = mongoose.model('Signal', signalSchema);
