const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const User = require('../models/User');
const Session = require('../models/Session');
const ClashRoom = require('../models/ClashRoom');
const ClashRoomSubmission = require('../models/ClashRoomSubmission');
const ClashPremade = require('../models/ClashPremade');
const { generateClashRoomProblem, flashModelId } = require('../utils/geminiClashRoom');
const { listRunnerLanguages } = require('../utils/sandboxRun');
const authMiddleware = require('../middleware/auth');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();
const ALL_RUNNER_LANGS = listRunnerLanguages();

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

// GET /api/admin/clashrooms — moderation list (no puzzle bulk in list)
router.get('/clashrooms', async (req, res) => {
    try {
        const rows = await ClashRoom.find({})
            .sort({ createdAt: -1 })
            .limit(100)
            .populate('createdBy', 'username')
            .select('slug phase status resolvedMode createdAt maxPlayers participantIds sourceKind')
            .lean();
        const out = rows.map((r) => ({
            slug: r.slug,
            phase: r.phase,
            status: r.status,
            resolvedMode: r.resolvedMode,
            sourceKind: r.sourceKind,
            host: r.createdBy && r.createdBy.username,
            participantCount: (r.participantIds || []).length,
            maxPlayers: r.maxPlayers,
            createdAt: r.createdAt
        }));
        res.json(out);
    } catch (err) {
        console.error('Admin list clashrooms error:', err);
        res.status(500).json({ error: 'Failed to list clash rooms' });
    }
});

// GET /api/admin/clashrooms/:slug/submissions — full source for moderation
router.get('/clashrooms/:slug/submissions', async (req, res) => {
    try {
        const room = await ClashRoom.findOne({ slug: req.params.slug }).select('_id slug title resolvedMode').lean();
        if (!room) return res.status(404).json({ error: 'Room not found' });

        const max = Math.min(300, Math.max(1, parseInt(req.query.limit, 10) || 200));
        const subs = await ClashRoomSubmission.find({ roomId: room._id })
            .populate('userId', 'username email')
            .sort({ lastAttemptAt: -1 })
            .limit(max)
            .lean();

        const submissions = subs.map((s) => ({
            id: s._id,
            username: (s.userId && s.userId.username) || 'User',
            email: (s.userId && s.userId.email) || '',
            language: s.language,
            accepted: s.accepted,
            sourceByteLength: s.sourceByteLength,
            totalTimeMs: s.totalTimeMs,
            bestAchievedAt: s.bestAchievedAt,
            lastAttemptAt: s.lastAttemptAt,
            code: s.code || '',
            lastFailures: s.lastFailures
        }));

        res.json({
            slug: room.slug,
            title: room.title,
            mode: room.resolvedMode,
            count: submissions.length,
            submissions
        });
    } catch (err) {
        console.error('Admin clashroom submissions error:', err);
        res.status(500).json({ error: 'Failed to load submissions' });
    }
});

// DELETE /api/admin/clashrooms/:slug
router.delete('/clashrooms/:slug', async (req, res) => {
    try {
        const room = await ClashRoom.findOne({ slug: req.params.slug });
        if (!room) return res.status(404).json({ error: 'Room not found' });
        await ClashRoomSubmission.deleteMany({ roomId: room._id });
        await ClashRoom.deleteOne({ _id: room._id });
        res.json({ message: `Room ${req.params.slug} deleted` });
    } catch (err) {
        console.error('Admin delete clashroom error:', err);
        res.status(500).json({ error: 'Failed to delete room' });
    }
});

// ─── Clash premade queue (FIFO for new private rooms) ───
router.get('/clash-premades', async (req, res) => {
    try {
        const rows = await ClashPremade.find({}).sort({ createdAt: -1 }).limit(200).lean();
        res.json(rows);
    } catch (err) {
        console.error('Admin list clash-premades error:', err);
        res.status(500).json({ error: 'Failed to list premades' });
    }
});

router.post('/clash-premades', async (req, res) => {
    try {
        const mode = String(req.body.resolvedMode || '').toLowerCase();
        if (!['fastest', 'reverse', 'shortest'].includes(mode)) {
            return res.status(400).json({ error: 'resolvedMode must be fastest, reverse, or shortest' });
        }
        const title = String(req.body.title || '').trim();
        if (!title) return res.status(400).json({ error: 'title is required' });
        const tests = Array.isArray(req.body.tests) ? req.body.tests : [];
        if (!tests.length) return res.status(400).json({ error: 'tests must be a non-empty array' });
        const doc = await ClashPremade.create({
            resolvedMode: mode,
            title,
            statement: String(req.body.statement || ''),
            samples: Array.isArray(req.body.samples) ? req.body.samples : [],
            tests: tests.map((t) => ({
                input: String(t.input != null ? t.input : ''),
                output: String(t.output != null ? t.output : ''),
                hidden: !!t.hidden
            })),
            allowedLanguages: Array.isArray(req.body.allowedLanguages)
                ? req.body.allowedLanguages.filter(Boolean).map(String)
                : []
        });
        res.status(201).json({ id: doc._id, message: 'Premade added to queue' });
    } catch (err) {
        console.error('Admin add clash-premade error:', err);
        res.status(500).json({ error: err.message || 'Failed to add premade' });
    }
});

router.post('/clash-premades/generate', async (req, res) => {
    try {
        const mode = String(req.body.resolvedMode || 'fastest').toLowerCase();
        if (!['fastest', 'reverse', 'shortest'].includes(mode)) {
            return res.status(400).json({ error: 'resolvedMode must be fastest, reverse, or shortest' });
        }
        const languages = Array.isArray(req.body.allowedLanguages) && req.body.allowedLanguages.length
            ? req.body.allowedLanguages.filter((l) => ALL_RUNNER_LANGS.includes(l))
            : ALL_RUNNER_LANGS;
        const payload = await generateClashRoomProblem({
            mode,
            topic: req.body.topic && String(req.body.topic).slice(0, 200),
            difficulty: req.body.difficulty && String(req.body.difficulty).slice(0, 50),
            languages,
            modelId: flashModelId()
        });
        const doc = await ClashPremade.create({
            resolvedMode: mode,
            title: payload.title,
            statement: payload.statement,
            samples: payload.samples,
            tests: payload.tests,
            allowedLanguages: payload.allowedLanguages || languages
        });
        res.status(201).json({
            id: doc._id,
            message: 'AI premade generated and added to queue',
            premade: doc
        });
    } catch (err) {
        console.error('Admin generate clash-premade error:', err);
        const status = err.message && err.message.includes('GEMINI_API_KEY') ? 503 : 400;
        res.status(status).json({ error: err.message || 'Failed to generate premade' });
    }
});

router.delete('/clash-premades/:id', async (req, res) => {
    try {
        await ClashPremade.deleteOne({ _id: req.params.id });
        res.json({ ok: true });
    } catch (err) {
        console.error('Admin delete clash-premade error:', err);
        res.status(500).json({ error: 'Failed to delete premade' });
    }
});

module.exports = router;
