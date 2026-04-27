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

const clashRoomSchema = new mongoose.Schema({
    slug: { type: String, required: true, unique: true, index: true },
    phase: {
        type: String,
        enum: ['preparing', 'lobby', 'countdown', 'live', 'ended'],
        required: true,
        index: true
    },
    status: {
        type: String,
        enum: ['verifying', 'ready', 'rejected'],
        required: true,
        index: true
    },
    resolvedMode: {
        type: String,
        enum: ['reverse', 'fastest', 'shortest'],
        required: true
    },
    allowedModesPick: [{ type: String }],
    languagesAll: { type: Boolean, default: false },
    allowedLanguages: [{ type: String }],
    maxPlayers: { type: Number, default: 50, min: 1, max: 50 },
    countdownDurationMs: { type: Number, default: 300000 },
    countdownEndsAt: { type: Date },
    roomDurationMs: { type: Number, default: 900000 },
    timeLimitMs: { type: Number, default: 8000 },
    sourceKind: { type: String, enum: ['auto', 'bank', 'ai'] },
    title: { type: String, required: true, trim: true },
    statement: { type: String, default: '' },
    samples: [ioPairSchema],
    tests: [testCaseSchema],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    participantIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    startedAt: { type: Date },
    endsAt: { type: Date },
    verificationReason: { type: String },
    aiModel: { type: String },
    aiReviewerModel: { type: String },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
}, { collection: 'clashrooms' });

clashRoomSchema.pre('save', function (next) {
    this.updatedAt = Date.now();
    next();
});

module.exports = mongoose.model('ClashRoom', clashRoomSchema);
