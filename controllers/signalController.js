'use strict';

const mongoose = require('mongoose');
const Signal     = require('../models/Signal');
const UserSignal = require('../models/UserSignal');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Overlay a user's personal UserSignal record onto a plain signal object.
 * Returns the signal with `userStatus` and `userResult` fields added.
 */
function overlayUserRecord(signalObj, userSignalMap) {
  const rec = userSignalMap.get(signalObj._id.toString());
  return {
    ...signalObj,
    userStatus: rec?.status ?? null,   // 'taken' | 'cancelled' | 'won' | 'lost' | 'draw' | null
    userResult: rec?.result ?? null,   // 'win' | 'loss' | 'draw' | null
  };
}

// ── Signal CRUD ───────────────────────────────────────────────────────────────

/**
 * POST /api/signals
 * Admin only — create a new trading signal
 */
exports.createSignal = async (req, res) => {
  try {
    const { asset, direction, timeframe, entryPrice, entryTime, expiryTime,
            confidence, indicators, notes } = req.body;

    if (!asset || !direction || !timeframe || !entryPrice || !expiryTime) {
      return res.status(400).json({
        message: 'asset, direction, timeframe, entryPrice and expiryTime are required',
      });
    }

    const signal = await Signal.create({
      asset, direction, timeframe, entryPrice, entryTime, expiryTime,
      confidence, indicators, notes,
      createdBy: req.user._id,
    });

    res.status(201).json({ message: 'Signal created', signal });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * GET /api/signals
 * Protected — paginated list, skipped/cancelled excluded by default.
 * Each signal is returned with the requesting user's personal status overlaid.
 */
exports.getSignals = async (req, res) => {
  try {
    const { status, asset, generatedBy, limit = 20, page = 1 } = req.query;

    const filter = {};
    if (status) {
      filter.status = status;
    } else {
      filter.status = { $nin: ['skipped', 'cancelled'] };
    }
    if (asset)       filter.asset       = new RegExp(asset, 'i');
    if (generatedBy) filter.generatedBy = generatedBy;

    const pageNum  = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip     = (pageNum - 1) * limitNum;

    const [signals, total] = await Promise.all([
      Signal.find(filter)
        .populate('createdBy', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Signal.countDocuments(filter),
    ]);

    // Fetch this user's UserSignal records for the returned signals
    const signalIds = signals.map((s) => s._id);
    const userRecords = await UserSignal.find({
      user:   req.user._id,
      signal: { $in: signalIds },
    }).lean();

    const userSignalMap = new Map(
      userRecords.map((r) => [r.signal.toString(), r])
    );

    res.json({
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
      signals: signals.map((s) => overlayUserRecord(s, userSignalMap)),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * GET /api/signals/live
 * Protected — pending + active signals with the user's personal status overlaid.
 */
exports.getLiveSignals = async (req, res) => {
  try {
    const signals = await Signal.find({
      status: { $in: ['pending', 'active'] },
    })
      .populate('createdBy', 'name')
      .sort({ entryTime: 1 })
      .lean();

    const signalIds = signals.map((s) => s._id);
    const userRecords = await UserSignal.find({
      user:   req.user._id,
      signal: { $in: signalIds },
    }).lean();

    const userSignalMap = new Map(
      userRecords.map((r) => [r.signal.toString(), r])
    );

    const overlaid = signals.map((s) => overlayUserRecord(s, userSignalMap));

    res.json({ count: overlaid.length, signals: overlaid });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * GET /api/signals/:id
 * Protected — single signal with the user's personal status overlaid.
 */
exports.getSignalById = async (req, res) => {
  try {
    const signal = await Signal.findById(req.params.id)
      .populate('createdBy', 'name email')
      .lean();

    if (!signal) {
      return res.status(404).json({ message: 'Signal not found' });
    }

    const userRecord = await UserSignal.findOne({
      user:   req.user._id,
      signal: signal._id,
    }).lean();

    const userSignalMap = new Map(
      userRecord ? [[signal._id.toString(), userRecord]] : []
    );

    res.json(overlayUserRecord(signal, userSignalMap));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * PUT /api/signals/:id
 * Admin only — update the shared signal document.
 */
exports.updateSignal = async (req, res) => {
  try {
    const allowedFields = [
      'asset', 'direction', 'timeframe', 'entryPrice', 'entryTime',
      'expiryTime', 'confidence', 'indicators', 'notes', 'status', 'result',
    ];

    const updates = {};
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });

    const signal = await Signal.findByIdAndUpdate(req.params.id, updates, {
      new: true, runValidators: true,
    });

    if (!signal) return res.status(404).json({ message: 'Signal not found' });

    res.json({ message: 'Signal updated', signal });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * DELETE /api/signals/:id
 * Admin only — delete signal and all associated UserSignal records.
 */
exports.deleteSignal = async (req, res) => {
  try {
    const signal = await Signal.findByIdAndDelete(req.params.id);
    if (!signal) return res.status(404).json({ message: 'Signal not found' });

    // Clean up all user interaction records for this signal
    await UserSignal.deleteMany({ signal: req.params.id });

    res.json({ message: 'Signal deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Per-user stats ────────────────────────────────────────────────────────────

/**
 * GET /api/signals/stats
 * Protected — win/loss stats for the REQUESTING USER only.
 *
 * - win / loss / draw: count of resolved UserSignal records for this user
 * - total: ONLY resolved signals (won + lost + draw) — unique to this user
 * - pending: signals this user has taken but not yet recorded a result for
 * - winRate: win / (win + loss + draw)
 *
 * Cancelled interactions are excluded entirely.
 */
exports.getStats = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user._id);

    const stats = await UserSignal.aggregate([
      // Only this user's records, exclude cancelled
      { $match: { user: userId, status: { $nin: ['cancelled'] } } },
      {
        $group: {
          _id:   '$result',   // 'win' | 'loss' | 'draw' | null
          count: { $sum: 1 },
        },
      },
    ]);

    const summary = { win: 0, loss: 0, draw: 0, pending: 0, total: 0 };

    stats.forEach(({ _id, count }) => {
      if (_id === 'win')       summary.win     += count;
      else if (_id === 'loss') summary.loss    += count;
      else if (_id === 'draw') summary.draw    += count;
      else                     summary.pending += count; // null result = taken, not yet resolved
    });

    // total = only signals the user actually completed (not pending ones)
    summary.total = summary.win + summary.loss + summary.draw;

    summary.winRate =
      summary.total > 0
        ? ((summary.win / summary.total) * 100).toFixed(1) + '%'
        : 'N/A';

    res.json(summary);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Per-user actions ──────────────────────────────────────────────────────────

/**
 * POST /api/signals/:id/result
 * Protected — record this user's personal result (WIN / LOSS / DRAW).
 * Creates or updates their UserSignal record. Does NOT touch the shared Signal.
 */
exports.setResult = async (req, res) => {
  try {
    const { result } = req.body;

    if (!['win', 'loss', 'draw'].includes(result)) {
      return res.status(400).json({ message: 'result must be win, loss or draw' });
    }

    const signal = await Signal.findById(req.params.id);
    if (!signal) return res.status(404).json({ message: 'Signal not found' });

    const statusMap = { win: 'won', loss: 'lost', draw: 'draw' };

    // Upsert: create if first time, update if they're changing their result
    const userSignal = await UserSignal.findOneAndUpdate(
      { user: req.user._id, signal: signal._id },
      {
        $set: {
          status:  statusMap[result],
          result,
          actedAt: new Date(),
        },
      },
      { upsert: true, new: true }
    );

    res.json({ message: 'Result saved', userSignal });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * POST /api/signals/:id/cancel
 * Protected — this user cancels the signal (won't trade it).
 * Creates a UserSignal with status 'cancelled'. Does NOT touch the shared Signal.
 */
exports.cancelSignal = async (req, res) => {
  try {
    const signal = await Signal.findById(req.params.id);
    if (!signal) return res.status(404).json({ message: 'Signal not found' });

    if (!['pending', 'active'].includes(signal.status)) {
      return res.status(400).json({ message: 'Only pending or active signals can be cancelled' });
    }

    const userSignal = await UserSignal.findOneAndUpdate(
      { user: req.user._id, signal: signal._id },
      {
        $set: {
          status:  'cancelled',
          result:  null,
          actedAt: new Date(),
        },
      },
      { upsert: true, new: true }
    );

    res.json({ message: 'Signal cancelled for you', userSignal });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
