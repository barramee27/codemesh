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

const fileSchema = new mongoose.Schema({
    id: String,
    name: String,
    content: String,
    language: String
}, { _id: false });

const commentSchema = new mongoose.Schema({
    id: String,
    fileId: String,
    line: Number,
    text: String,
    author: String,
    createdAt: { type: Date, default: Date.now }
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
    // Keep old fields for backward compatibility, but use files array mostly
    language: {
        type: String,
        default: 'plaintext'
    },
    code: {
        type: String,
        default: ''
    },
    files: [fileSchema],
    comments: [commentSchema],
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
    /** Bcrypt hash of class key (private sessions only). Never sent to clients. */
    classKeyHash: {
        type: String,
        select: false
    },
    /** Users who entered the correct class key and may rejoin without re-entering it. */
    keyAccess: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    /** Role assigned to new collaborators when they first join (owner chooses editor or viewer). */
    defaultJoinRole: {
        type: String,
        enum: ['editor', 'viewer'],
        default: 'editor'
    },
    /** When false, only owner/admin can copy, highlight, or download session code. */
    allowCollaboratorCopy: {
        type: Boolean,
        default: false
    },
    /** Optional reference PDF for split view (owner or site admin). */
    referencePdf: {
        storageName: { type: String },
        originalName: { type: String },
        uploadedAt: { type: Date }
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
sessionSchema.index({ 'collaborators.user': 1 });

module.exports = mongoose.model('Session', sessionSchema);
