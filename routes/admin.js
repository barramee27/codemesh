const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');
const User = require('../models/User');
const Session = require('../models/Session');
const Clash = require('../models/Clash');
const ClashSubmission = require('../models/ClashSubmission');
const authMiddleware = require('../middleware/auth');
const adminAuth = require('../middleware/adminAuth');
const { generateClash, verifyClashProblem, flashModelId, proModelId } = require('../utils/geminiClash');

const ROOM_DURATION_PRESETS_MS = {
    5: 5 * 60 * 1000,
    10: 10 * 60 * 1000,
    15: 15 * 60 * 1000,
    30: 30 * 60 * 1000,
    60: 60 * 60 * 1000
};

function makeClashSlug() {
    return 'c' + crypto.randomBytes(4).toString('hex');
}

function resolveRoomDurationMs(body) {
    const m = Number(body.roomDurationMinutes);
    if (ROOM_DURATION_PRESETS_MS[m]) return ROOM_DURATION_PRESETS_MS[m];
    return ROOM_DURATION_PRESETS_MS[15];
}

const router = express.Router();

// All admin routes require auth + admin role
router.use(authMiddleware, adminAuth);

// ─── File uploads ───
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const safeName = Buffer.from(file.originalname, 'latin1').toString('utf8').replace(/[^a-zA-Z0-9._-]/g, '_');
        const unique = Date.now() + '-' + Math.random().toString(36).slice(2, 9);
        cb(null, unique + '-' + safeName);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        const blocked = /\.(exe|bat|cmd|sh|ps1|dll|so)$/i.test(file.originalname);
        if (blocked) return cb(new Error('File type not allowed'));
        cb(null, true);
    }
});

// GET /api/admin/files — list uploaded files
router.get('/files', (req, res) => {
    try {
        const files = fs.readdirSync(UPLOADS_DIR)
            .filter(f => fs.statSync(path.join(UPLOADS_DIR, f)).isFile())
            .map(name => {
                const stat = fs.statSync(path.join(UPLOADS_DIR, name));
                return { name, size: stat.size, uploadedAt: stat.mtime };
            })
            .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
        res.json(files);
    } catch (err) {
        console.error('Admin list files error:', err);
        res.status(500).json({ error: 'Failed to list files' });
    }
});

// POST /api/admin/files — upload file
router.post('/files', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    res.json({
        message: 'File uploaded',
        file: { name: req.file.filename, size: req.file.size, url: `/uploads/${req.file.filename}` }
    });
});

// DELETE /api/admin/files/:name — delete file
router.delete('/files/:name', (req, res) => {
    try {
        const name = path.basename(req.params.name);
        if (!name || name.includes('..')) return res.status(400).json({ error: 'Invalid filename' });
        const filePath = path.join(UPLOADS_DIR, name);
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
        fs.unlinkSync(filePath);
        res.json({ message: `File "${name}" deleted` });
    } catch (err) {
        console.error('Admin delete file error:', err);
        res.status(500).json({ error: 'Failed to delete file' });
    }
});

// GET /api/admin/users — list all users
router.get('/users', async (req, res) => {
    try {
        const usersWithStats = await User.aggregate([
            { $sort: { createdAt: -1 } },
            { $lookup: { from: 'sessions', localField: '_id', foreignField: 'owner', as: 'sessions' } },
            { $addFields: { sessionCount: { $size: '$sessions' } } },
            { $project: { username: 1, email: 1, role: 1, banned: 1, createdAt: 1, sessionCount: 1 } }
        ]);

        res.json(usersWithStats);
    } catch (err) {
        console.error('Admin list users error:', err);
        res.status(500).json({ error: 'Failed to list users' });
    }
});

// PUT /api/admin/users/:id/ban — ban a user
router.put('/users/:id/ban', async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.role === 'admin') return res.status(403).json({ error: 'Cannot ban an admin' });

        user.banned = true;
        await user.save();
        res.json({ message: `User ${user.username} has been banned`, user: user.toJSON() });
    } catch (err) {
        console.error('Admin ban error:', err);
        res.status(500).json({ error: 'Failed to ban user' });
    }
});

// PUT /api/admin/users/:id/unban — unban a user
router.put('/users/:id/unban', async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        user.banned = false;
        await user.save();
        res.json({ message: `User ${user.username} has been unbanned`, user: user.toJSON() });
    } catch (err) {
        console.error('Admin unban error:', err);
        res.status(500).json({ error: 'Failed to unban user' });
    }
});

// DELETE /api/admin/users/:id — delete user and their sessions
router.delete('/users/:id', async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.role === 'admin') return res.status(403).json({ error: 'Cannot delete an admin' });

        // Delete all sessions owned by user
        const deletedSessions = await Session.deleteMany({ owner: user._id });

        // Remove user from collaborators in other sessions
        await Session.updateMany(
            { 'collaborators.user': user._id },
            { $pull: { collaborators: { user: user._id } } }
        );

        await User.deleteOne({ _id: user._id });
        res.json({
            message: `User ${user.username} and ${deletedSessions.deletedCount} sessions deleted`
        });
    } catch (err) {
        console.error('Admin delete user error:', err);
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

// GET /api/admin/sessions — list all sessions
router.get('/sessions', async (req, res) => {
    try {
        const sessions = await Session.find()
            .populate('owner', 'username email')
            .sort({ updatedAt: -1 })
            .limit(100)
            .lean();
        res.json(sessions);
    } catch (err) {
        console.error('Admin list sessions error:', err);
        res.status(500).json({ error: 'Failed to list sessions' });
    }
});

// DELETE /api/admin/sessions/:id — delete any session
router.delete('/sessions/:id', async (req, res) => {
    try {
        const session = await Session.findOne({ sessionId: req.params.id });
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const ownerId = session.owner;
        await Session.deleteOne({ _id: session._id });
        
        // Check if owner was a guest and delete account if no sessions remain
        if (ownerId) {
            try {
                const user = await User.findById(ownerId);
                if (user && user.email && user.email.endsWith('@guest.codemesh.local')) {
                    const remainingSessions = await Session.find({ owner: ownerId });
                    if (remainingSessions.length === 0) {
                        // Remove from collaborators in other sessions
                        await Session.updateMany(
                            { 'collaborators.user': ownerId },
                            { $pull: { collaborators: { user: ownerId } } }
                        );
                        await User.deleteOne({ _id: ownerId });
                        console.log(`Deleted guest account after admin session deletion: ${user.username}`);
                    }
                }
            } catch (err) {
                console.error('Error cleaning up guest account:', err);
            }
        }
        
        res.json({ message: `Session "${session.title}" deleted` });
    } catch (err) {
        console.error('Admin delete session error:', err);
        res.status(500).json({ error: 'Failed to delete session' });
    }
});

// GET /api/admin/sessions/:sessionId/detail — full session payload (files/code) for inspection
router.get('/sessions/:sessionId/detail', async (req, res) => {
    try {
        const session = await Session.findOne({ sessionId: req.params.sessionId })
            .populate('owner', 'username email')
            .populate('collaborators.user', 'username email')
            .lean();
        if (!session) return res.status(404).json({ error: 'Session not found' });
        const maxFileChars = 400000;
        const files = (session.files || []).map((f) => ({
            id: f.id,
            name: f.name,
            language: f.language,
            content: f.content && f.content.length > maxFileChars
                ? f.content.slice(0, maxFileChars) + '\n… [truncated]'
                : f.content
        }));
        const collaborators = (session.collaborators || []).map((c) => ({
            username: c.user && c.user.username,
            email: c.user && c.user.email,
            role: c.role
        }));

        res.json({
            sessionId: session.sessionId,
            title: session.title,
            language: session.language,
            code: session.code,
            files,
            comments: session.comments,
            owner: session.owner,
            collaborators,
            isPublic: session.isPublic,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt
        });
    } catch (err) {
        console.error('Admin session detail error:', err);
        res.status(500).json({ error: 'Failed to load session' });
    }
});

// GET /api/admin/clashes — all clashes including verifying / rejected
router.get('/clashes', async (req, res) => {
    try {
        const rows = await Clash.find({})
            .sort({ createdAt: -1 })
            .limit(100)
            .populate('createdBy', 'username')
            .select('slug mode title status createdAt roomDurationMs verificationReason')
            .lean();
        res.json(rows);
    } catch (err) {
        console.error('Admin list clashes error:', err);
        res.status(500).json({ error: 'Failed to list clashes' });
    }
});

// POST /api/admin/clashes/batch — Flash + Pro per item (sequential; max 5 per request)
router.post('/clashes/batch', async (req, res) => {
    try {
        const count = Math.min(5, Math.max(1, parseInt(req.body.count, 10) || 1));
        const mode = req.body.mode;
        if (!['reverse', 'fastest', 'shortest'].includes(mode)) {
            return res.status(400).json({ error: 'mode must be reverse, fastest, or shortest' });
        }
        const topic = req.body.topic && String(req.body.topic).slice(0, 200);
        const difficulty = req.body.difficulty && String(req.body.difficulty).slice(0, 50);
        const roomDurationMs = resolveRoomDurationMs(req.body);
        const timeLimitMs = Math.min(Number(req.body.timeLimitMs) || 8000, 15000);
        const flashModel = flashModelId();
        const proModel = proModelId();

        const created = [];
        const failed = [];

        for (let i = 0; i < count; i++) {
            try {
                const payload = await generateClash({
                    mode,
                    topic,
                    difficulty,
                    languages: req.body.languages,
                    modelId: flashModel
                });
                const verdict = await verifyClashProblem({
                    mode,
                    title: payload.title,
                    statement: payload.statement,
                    samples: payload.samples,
                    tests: payload.tests,
                    modelId: proModel
                });
                if (!verdict.approved) {
                    failed.push({ index: i, error: verdict.reason || 'Pro rejected' });
                    continue;
                }
                let slug = makeClashSlug();
                for (let j = 0; j < 5; j++) {
                    const exists = await Clash.findOne({ slug });
                    if (!exists) break;
                    slug = makeClashSlug();
                }
                const doc = await Clash.create({
                    slug,
                    mode,
                    status: 'ready',
                    title: payload.title,
                    statement: payload.statement,
                    samples: payload.samples,
                    tests: payload.tests,
                    allowedLanguages: payload.allowedLanguages,
                    timeLimitMs,
                    roomDurationMs,
                    createdBy: req.user.id,
                    aiModel: flashModel,
                    aiReviewerModel: proModel
                });
                created.push({ slug: doc.slug, title: doc.title });
            } catch (e) {
                failed.push({ index: i, error: e.message || String(e) });
            }
        }

        res.json({ created, failed, flashModel, proModel });
    } catch (err) {
        console.error('Admin batch clashes error:', err);
        res.status(500).json({ error: err.message || 'Batch failed' });
    }
});

// GET /api/admin/clashes/:slug/submissions — every submission with full source (admin only)
router.get('/clashes/:slug/submissions', async (req, res) => {
    try {
        const clash = await Clash.findOne({ slug: req.params.slug }).select('_id slug title mode').lean();
        if (!clash) return res.status(404).json({ error: 'Clash not found' });

        const max = Math.min(300, Math.max(1, parseInt(req.query.limit, 10) || 200));
        const subs = await ClashSubmission.find({ clashId: clash._id })
            .populate('userId', 'username email')
            .sort({ createdAt: -1 })
            .limit(max)
            .lean();

        const submissions = subs.map((s) => ({
            id: s._id,
            username: (s.userId && s.userId.username) || 'User',
            email: (s.userId && s.userId.email) || '',
            language: s.language,
            accepted: s.accepted,
            charCount: s.charCount,
            totalTimeMs: s.totalTimeMs,
            createdAt: s.createdAt,
            code: s.code || '',
            testResults: s.testResults,
            failures: s.failures
        }));

        res.json({
            slug: clash.slug,
            title: clash.title,
            mode: clash.mode,
            count: submissions.length,
            submissions
        });
    } catch (err) {
        console.error('Admin clash submissions error:', err);
        res.status(500).json({ error: 'Failed to load submissions' });
    }
});

// DELETE /api/admin/clashes/:slug
router.delete('/clashes/:slug', async (req, res) => {
    try {
        const clash = await Clash.findOne({ slug: req.params.slug });
        if (!clash) return res.status(404).json({ error: 'Clash not found' });
        await ClashSubmission.deleteMany({ clashId: clash._id });
        await Clash.deleteOne({ _id: clash._id });
        res.json({ message: `Clash ${req.params.slug} deleted` });
    } catch (err) {
        console.error('Admin delete clash error:', err);
        res.status(500).json({ error: 'Failed to delete clash' });
    }
});

module.exports = router;
