const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const User = require('../models/User');
const Session = require('../models/Session');
const authMiddleware = require('../middleware/auth');
const adminAuth = require('../middleware/adminAuth');

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

module.exports = router;
