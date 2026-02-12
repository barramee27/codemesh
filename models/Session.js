const mongoose = require('mongoose');

const collaboratorSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    role: {
        type: String,
        enum: ['editor', 'viewer'],
        default: 'editor'
    }
}, { _id: false });

const sessionSchema = new mongoose.Schema({
    sessionId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    title: {
        type: String,
        required: true,
        trim: true,
        default: 'Untitled Session'
    },
    language: {
        type: String,
        default: 'javascript'
    },
    code: {
        type: String,
        default: ''
    },
    owner: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    collaborators: [collaboratorSchema],
    isPublic: {
        type: Boolean,
        default: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

sessionSchema.pre('save', function (next) {
    this.updatedAt = Date.now();
    next();
});

sessionSchema.index({ owner: 1, updatedAt: -1 });

module.exports = mongoose.model('Session', sessionSchema);
