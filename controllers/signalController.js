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
 *   ?status=active|expired|won|lost|skipped
 *   ?asset=EUR/USD
 *   ?generatedBy=engine|manual
 *   ?limit=20  (default 20, max 100)
 *   ?page=1
 *
 * By default, 'skipped' signals (expired with no user action) are excluded
 * unless ?status=skipped is explicitly requested.
 */
exports.getSignals = async (req, res) => {
  try {
    const { status, asset, generatedBy, limit = 20, page = 1 } = req.query;

    const filter = {};

    if (status) {
      filter.status = status;
    } else {
      // Default: exclude skipped and cancelled signals
      filter.status = { $nin: ['skipped', 'cancelled'] };
    }

    if (asset) filter.asset = new RegExp(asset, 'i');
    if (generatedBy) filter.generatedBy = generatedBy;

    const pageNum  = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip     = (pageNum - 1) * limitNum;

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
 * Protected — returns pending (entry window not yet open) and active signals.
 */
exports.getLiveSignals = async (req, res) => {
  try {
    const signals = await Signal.find({
      status: { $in: ['pending', 'active'] },
    })
      .populate('createdBy', 'name')
      .sort({ entryTime: 1 }); // soonest entry first

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
 * Protected — win/loss stats summary.
 * Only counts signals the user actually acted on (won/lost/draw).
 * Skipped signals (expired with no action) are excluded entirely.
 */
exports.getStats = async (req, res) => {
  try {
    const stats = await Signal.aggregate([
      // Exclude skipped and cancelled signals — user never traded them
      { $match: { status: { $nin: ['skipped', 'cancelled'] } } },
      {
        $group: {
          _id: '$result',
          count: { $sum: 1 },
        },
      },
    ]);

    const summary = { win: 0, loss: 0, draw: 0, pending: 0, total: 0 };

    stats.forEach(({ _id, count }) => {
      if (_id === 'win')       summary.win  = count;
      else if (_id === 'loss') summary.loss = count;
      else if (_id === 'draw') summary.draw = count;
      else                     summary.pending += count; // null = active, not yet resolved
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

/**
 * POST /api/signals/:id/cancel
 * Protected (any user) — cancel a pending or active signal the user doesn't want.
 * Cancelled signals are excluded from stats (same as skipped).
 */
exports.cancelSignal = async (req, res) => {
  try {
    const signal = await Signal.findById(req.params.id);
    if (!signal) {
      return res.status(404).json({ message: 'Signal not found' });
    }

    if (!['pending', 'active'].includes(signal.status)) {
      return res.status(400).json({ message: 'Only pending or active signals can be cancelled' });
    }

    signal.status = 'cancelled';
    await signal.save();

    res.json({ message: 'Signal cancelled', signal });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
 /* This is the "user clicks WIN/LOSS button" action.
 * Once a result is set the signal is counted in stats.
 */
exports.setResult = async (req, res) => {
  try {
    const { result } = req.body;

    if (!['win', 'loss', 'draw'].includes(result)) {
      return res.status(400).json({ message: 'result must be win, loss or draw' });
    }

    const signal = await Signal.findById(req.params.id);
    if (!signal) {
      return res.status(404).json({ message: 'Signal not found' });
    }

    // Map result → status
    const statusMap = { win: 'won', loss: 'lost', draw: 'expired' };

    signal.result = result;
    // If it was skipped (user came back late), un-skip it and record the result
    signal.status = statusMap[result];
    await signal.save();

    res.json({ message: 'Result saved', signal });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
