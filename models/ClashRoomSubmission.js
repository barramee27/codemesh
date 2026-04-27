const mongoose = require('mongoose');

/**
 * Leaderboard uses sourceByteLength = Buffer.byteLength(code.trim(), 'utf8') (shortest mode).
 */
const clashRoomSubmissionSchema = new mongoose.Schema({
    roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClashRoom', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    accepted: { type: Boolean, default: false },
    totalTimeMs: { type: Number, default: 0 },
    sourceByteLength: { type: Number, default: 0 },
    language: { type: String, default: '' },
    code: { type: String, default: '' },
    bestAchievedAt: { type: Date },
    lastAttemptAt: { type: Date },
    lastFailures: { type: mongoose.Schema.Types.Mixed }
}, { collection: 'clashroomsubmissions' });

clashRoomSubmissionSchema.index({ roomId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('ClashRoomSubmission', clashRoomSubmissionSchema);
