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

/** Admin-seeded puzzles consumed when a new clash room is created (FIFO per mode). */
const clashPremadeSchema = new mongoose.Schema({
    resolvedMode: {
        type: String,
        enum: ['reverse', 'fastest', 'shortest'],
        required: true,
        index: true
    },
    status: {
        type: String,
        enum: ['available', 'consumed'],
        default: 'available',
        index: true
    },
    title: { type: String, required: true, trim: true },
    statement: { type: String, default: '' },
    samples: [ioPairSchema],
    tests: [testCaseSchema],
    allowedLanguages: [{ type: String }],
    consumedAt: { type: Date },
    createdAt: { type: Date, default: Date.now }
}, { collection: 'clashpremades' });

module.exports = mongoose.model('ClashPremade', clashPremadeSchema);
