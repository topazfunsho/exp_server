const Signal = require('../models/Signal');

/**
 * POST /api/signals
 * Admin only — create a new trading signal
 */
exports.createSignal = async (req, res) => {
  try {
    const { asset, direction, timeframe, entryPrice, expiryTime, confidence, indicators, notes } =
      req.body;

    if (!asset || !direction || !timeframe || !entryPrice || !expiryTime) {
      return res.status(400).json({
        message: 'asset, direction, timeframe, entryPrice and expiryTime are required',
      });
    }

    const signal = await Signal.create({
      asset,
      direction,
      timeframe,
      entryPrice,
      expiryTime,
      confidence,
      indicators,
      notes,
      createdBy: req.user._id,
    });

    res.status(201).json({ message: 'Signal created', signal });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * GET /api/signals
 * Protected — get all signals (newest first)
 * Query params:
 *   ?status=active|expired|won|lost
 *   ?asset=EUR/USD
 *   ?limit=20  (default 20, max 100)
 *   ?page=1
 */
exports.getSignals = async (req, res) => {
  try {
    const { status, asset, limit = 20, page = 1 } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (asset) filter.asset = new RegExp(asset, 'i');

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const [signals, total] = await Promise.all([
      Signal.find(filter)
        .populate('createdBy', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
      Signal.countDocuments(filter),
    ]);

    res.json({
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
      signals,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * GET /api/signals/live
 * Protected — get only currently active signals (not yet expired)
 */
exports.getLiveSignals = async (req, res) => {
  try {
    const now = new Date();

    const signals = await Signal.find({
      status: 'active',
      expiryTime: { $gt: now },
    })
      .populate('createdBy', 'name')
      .sort({ expiryTime: 1 }); // soonest expiry first

    res.json({ count: signals.length, signals });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * GET /api/signals/:id
 * Protected — get a single signal by ID
 */
exports.getSignalById = async (req, res) => {
  try {
    const signal = await Signal.findById(req.params.id).populate('createdBy', 'name email');

    if (!signal) {
      return res.status(404).json({ message: 'Signal not found' });
    }

    res.json(signal);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * PUT /api/signals/:id
 * Admin only — update a signal (e.g. set result after expiry)
 */
exports.updateSignal = async (req, res) => {
  try {
    const allowedFields = [
      'asset',
      'direction',
      'timeframe',
      'entryPrice',
      'expiryTime',
      'confidence',
      'indicators',
      'notes',
      'status',
      'result',
    ];

    // Only pick allowed fields to prevent mass-assignment
    const updates = {};
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });

    const signal = await Signal.findByIdAndUpdate(req.params.id, updates, {
      new: true,
      runValidators: true,
    });

    if (!signal) {
      return res.status(404).json({ message: 'Signal not found' });
    }

    res.json({ message: 'Signal updated', signal });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * DELETE /api/signals/:id
 * Admin only — delete a signal
 */
exports.deleteSignal = async (req, res) => {
  try {
    const signal = await Signal.findByIdAndDelete(req.params.id);

    if (!signal) {
      return res.status(404).json({ message: 'Signal not found' });
    }

    res.json({ message: 'Signal deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * GET /api/signals/stats
 * Protected — win/loss stats summary
 */
exports.getStats = async (req, res) => {
  try {
    const stats = await Signal.aggregate([
      {
        $group: {
          _id: '$result',
          count: { $sum: 1 },
        },
      },
    ]);

    const summary = { win: 0, loss: 0, draw: 0, pending: 0, total: 0 };

    stats.forEach(({ _id, count }) => {
      if (_id === 'win') summary.win = count;
      else if (_id === 'loss') summary.loss = count;
      else if (_id === 'draw') summary.draw = count;
      else summary.pending += count; // null result = not yet resolved
      summary.total += count;
    });

    const resolved = summary.win + summary.loss + summary.draw;
    summary.winRate =
      resolved > 0 ? ((summary.win / resolved) * 100).toFixed(1) + '%' : 'N/A';

    res.json(summary);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
