const mongoose = require('mongoose');

const ioPairSchema = new mongoose.Schema({
    input: { type: String, default: '' },
    output: { type: String, default: '' }
}, { _id: false });

const testCaseSchema = new mongoose.Schema({
    input: { type: String, default: '' },
    output: { type: String, default: '' },
    hidden: { type: Boolean, default: false }
}, { _id: false });

const clashSchema = new mongoose.Schema({
    slug: { type: String, required: true, unique: true, index: true },
    mode: {
        type: String,
        enum: ['reverse', 'fastest', 'shortest'],
        required: true
    },
    /** verifying = Flash done, Pro review in progress; ready = Pro approved, waiting for Start; live = timer running; ended = time up; rejected = Pro failed */
    status: {
        type: String,
        enum: ['verifying', 'ready', 'live', 'ended', 'rejected'],
        index: true
    },
    title: { type: String, required: true, trim: true },
    statement: { type: String, default: '' },
    allowedLanguages: [{ type: String }],
    timeLimitMs: { type: Number, default: 8000 },
    /** Wall-clock match window after host clicks Start (default 15 min). */
    roomDurationMs: { type: Number, default: 900000 },
    samples: [ioPairSchema],
    tests: [testCaseSchema],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    expiresAt: { type: Date },
    startedAt: { type: Date },
    endsAt: { type: Date },
    aiModel: { type: String },
    aiReviewerModel: { type: String },
    aiPromptVersion: { type: String, default: '2' },
    verificationReason: { type: String },
    /** CodinGame-style room: preparing → lobby → countdown → live (mirrors match); ended when time up */
    roomPhase: {
        type: String,
        enum: ['preparing', 'lobby', 'countdown', 'live', 'ended'],
        index: true
    },
    /** Modes the host allowed at create time; actual `mode` is chosen at create (hidden until live). */
    allowedModesPick: [{ type: String }],
    languagesAll: { type: Boolean, default: false },
    participantIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    maxPlayers: { type: Number, default: 50, min: 1, max: 50 },
    countdownEndsAt: { type: Date },
    countdownDurationMs: { type: Number, default: 300000 },
    sourceKind: { type: String, enum: ['ai', 'bank'] },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

clashSchema.pre('save', function (next) {
    this.updatedAt = Date.now();
    next();
});

module.exports = mongoose.model('Clash', clashSchema);
