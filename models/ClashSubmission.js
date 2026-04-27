const mongoose = require('mongoose');

const testResultSchema = new mongoose.Schema({
    index: { type: Number, required: true },
    pass: { type: Boolean, required: true },
    hidden: { type: Boolean, default: false },
    timeMs: { type: Number, default: 0 },
    stdoutSnippet: { type: String, default: '' },
    stderrSnippet: { type: String, default: '' }
}, { _id: false });

const clashSubmissionSchema = new mongoose.Schema({
    clashId: { type: mongoose.Schema.Types.ObjectId, ref: 'Clash', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    language: { type: String, required: true },
    code: { type: String, required: true },
    charCount: { type: Number, required: true },
    accepted: { type: Boolean, default: false },
    totalTimeMs: { type: Number, default: 0 },
    testResults: [testResultSchema],
    /** For failed public tests only — safe to return to client */
    failures: [{
        index: Number,
        inputPreview: String,
        expected: String,
        actual: String,
        stderr: { type: String, default: '' }
    }],
    createdAt: { type: Date, default: Date.now }
});

clashSubmissionSchema.index({ clashId: 1, userId: 1, createdAt: -1 });
clashSubmissionSchema.index({ clashId: 1, accepted: 1, totalTimeMs: 1 });
clashSubmissionSchema.index({ clashId: 1, accepted: 1, charCount: 1 });

module.exports = mongoose.model('ClashSubmission', clashSubmissionSchema);
