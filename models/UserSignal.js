/**
 * UserSignal — per-user interaction record for a signal.
 *
 * The Signal document itself is shared and neutral.
 * Each user who acts on a signal gets their own UserSignal record
 * that tracks their personal result, status, and timestamps.
 *
 * One UserSignal per (user, signal) pair — enforced by unique index.
 */

'use strict';

const mongoose = require('mongoose');

const userSignalSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    signal: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Signal',
      required: true,
    },
    // Personal status for this user
    status: {
      type: String,
      enum: ['taken', 'cancelled', 'won', 'lost', 'draw'],
      required: true,
    },
    // Personal result for this user
    result: {
      type: String,
      enum: ['win', 'loss', 'draw', null],
      default: null,
    },
    // When the user acted on this signal
    actedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// One record per user per signal
userSignalSchema.index({ user: 1, signal: 1 }, { unique: true });

// Fast lookup by user
userSignalSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('UserSignal', userSignalSchema);
