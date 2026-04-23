const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const Session = require('../models/Session');
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');
const { fetchPublicRepoFiles } = require('../utils/githubImport');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';

const router = express.Router();

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{3,50}$/;

// POST /api/sessions/join-or-create — load or create a public session by ID (shareable URLs like /A2-042)
router.post('/join-or-create', authMiddleware, async (req, res) => {
    try {
        const raw = (req.body.sessionId || '').trim();
        if (!SESSION_ID_RE.test(raw)) {
            return res.status(400).json({
                error: 'Session ID must be 3–50 characters: letters, numbers, _ or - only'
            });
        }

        let session = await Session.findOne({ sessionId: raw })
            .populate('owner', 'username')
            .populate('collaborators.user', 'username');

        if (session) {
            const isOwner = session.owner._id.toString() === req.user.id;
            const isCollab = session.collaborators.some(
                c => c.user && c.user._id.toString() === req.user.id
            );
            if (!session.isPublic && !isOwner && !isCollab) {
                return res.status(403).json({ error: 'This session is private' });
            }
            return res.json(session);
        }

        const fileId = 'f_' + uuidv4().split('-')[0];
        session = new Session({
            sessionId: raw,
            title: (req.body.title && String(req.body.title).trim()) || raw,
            language: 'javascript',
            code: '',
            files: [{
                id: fileId,
                name: 'main.js',
                content: '',
                language: 'javascript'
            }],
            owner: req.user.id,
            isPublic: true
        });
        await session.save();
        await session.populate('owner', 'username');
        return res.status(201).json(session);
    } catch (err) {
        console.error('join-or-create error:', err);
        return res.status(500).json({ error: 'Failed to open or create session' });
    }
});

// POST /api/sessions — create new session
router.post('/', authMiddleware, async (req, res) => {
    try {
        const { title, language, customSessionId } = req.body;

        // Custom session ID validation
        let sessionId;
        if (customSessionId) {
            const cleanId = customSessionId.trim();
            if (!SESSION_ID_RE.test(cleanId)) {
                return res.status(400).json({
                    error: 'Custom ID must be 3-50 characters, alphanumeric with _ or - only'
                });
            }
            // Check uniqueness
            const existing = await Session.findOne({ sessionId: cleanId });
            if (existing) {
                return res.status(409).json({ error: 'This session ID is already taken' });
            }
            sessionId = cleanId;
        } else {
            sessionId = uuidv4().split('-')[0];
        }

        const session = new Session({
            sessionId,
            title: title || 'Untitled Session',
            language: language || 'javascript',
            code: '',
            owner: req.user.id
        });
        await session.save();
        await session.populate('owner', 'username');
        res.status(201).json(session);
    } catch (err) {
        console.error('Create session error:', err);
        res.status(500).json({ error: 'Failed to create session' });
    }
});

// GET /api/sessions — list user's sessions
router.get('/', authMiddleware, async (req, res) => {
    try {
        const sessions = await Session.find({
            $or: [
                { owner: req.user.id },
                { 'collaborators.user': req.user.id }
            ]
        })
            .populate('owner', 'username')
            .sort({ updatedAt: -1 })
            .limit(50)
            .lean();

        res.json(sessions);
    } catch (err) {
        console.error('List sessions error:', err);
        res.status(500).json({ error: 'Failed to list sessions' });
    }
});

// POST /api/sessions/:id/import-github — append files from a public GitHub repo (owner/repo)
router.post('/:id/import-github', authMiddleware, async (req, res) => {
    try {
        const session = await Session.findOne({ sessionId: req.params.id });
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        const isOwner = session.owner.toString() === req.user.id;
        const collab = session.collaborators.find((c) => c.user.toString() === req.user.id);
        const canEdit = isOwner || (collab && collab.role === 'editor') || req.user.role === 'admin';
        if (!canEdit) {
            return res.status(403).json({ error: 'You need editor access to import files' });
        }

        const { repo, branch } = req.body;
        if (!repo || typeof repo !== 'string') {
            return res.status(400).json({ error: 'Body must include repo as "owner/name"' });
        }

        const { files: imported, truncated, branch: usedBranch } = await fetchPublicRepoFiles(repo, branch);
        if (!imported.length) {
            return res.status(400).json({
                error: 'No suitable text files found (size/type limits), or repo is empty',
                truncated
            });
        }

        const existing = Array.isArray(session.files) ? [...session.files] : [];
        session.files = existing.concat(imported);
        session.updatedAt = Date.now();
        await session.save();
        await session.populate('owner', 'username');
        await session.populate('collaborators.user', 'username');

        res.json({
            message: `Imported ${imported.length} file(s) from ${String(repo).trim()}@${usedBranch}`,
            importedCount: imported.length,
            truncated,
            branch: usedBranch,
            session
        });
    } catch (err) {
        console.error('import-github error:', err.message);
        let status = 400;
        if (err.status === 404) status = 404;
        else if (String(err.message || '').toLowerCase().includes('rate limit')) status = 429;
        else if (typeof err.status === 'number' && err.status >= 400 && err.status < 500) status = err.status;
        res.status(status).json({ error: err.message || 'GitHub import failed' });
    }
});

// GET /api/sessions/:id — get session by sessionId (auth required unless public)
router.get('/:id', async (req, res) => {
    try {
        const session = await Session.findOne({ sessionId: req.params.id })
            .populate('owner', 'username')
            .populate('collaborators.user', 'username');

        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        const authHeader = req.headers.authorization;
        const hasAuth = authHeader && authHeader.startsWith('Bearer ');
        let userId = null;
        if (hasAuth) {
            try {
                const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
                userId = decoded.id;
            } catch (e) { /* invalid token */ }
        }

        const isOwner = userId && session.owner._id.toString() === userId;
        const isCollab = userId && session.collaborators.some(c => c.user && c.user._id.toString() === userId);
        if (!session.isPublic && !isOwner && !isCollab) {
            if (!userId) {
                return res.status(401).json({ error: 'Authentication required' });
            }
            return res.status(403).json({ error: 'You do not have access to this session' });
        }

        res.json(session);
    } catch (err) {
        console.error('Get session error:', err);
        res.status(500).json({ error: 'Failed to get session' });
    }
});

// PUT /api/sessions/:id — update session
router.put('/:id', authMiddleware, async (req, res) => {
    try {
        const { code, title, language, files } = req.body;
        const update = {};
        if (code !== undefined) update.code = code;
        if (title !== undefined) update.title = title;
        if (language !== undefined) update.language = language;
        if (files !== undefined && Array.isArray(files)) update.files = files;
        update.updatedAt = Date.now();

        const session = await Session.findOneAndUpdate(
            { sessionId: req.params.id },
            { $set: update },
            { new: true }
        ).populate('owner', 'username');

        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        res.json(session);
    } catch (err) {
        console.error('Update session error:', err);
        res.status(500).json({ error: 'Failed to update session' });
    }
});

// PUT /api/sessions/:id/role — set collaborator role (owner or admin only)
router.put('/:id/role', authMiddleware, async (req, res) => {
    try {
        const { userId, role } = req.body;

        if (!userId || !['editor', 'viewer'].includes(role)) {
            return res.status(400).json({ error: 'userId and role (editor/viewer) required' });
        }

        const session = await Session.findOne({ sessionId: req.params.id });
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        // Only owner or admin can change roles
        const isOwner = session.owner.toString() === req.user.id;
        const isAdmin = req.user.role === 'admin';
        if (!isOwner && !isAdmin) {
            return res.status(403).json({ error: 'Only the session owner or admin can change roles' });
        }

        // Find or add collaborator
        const collabIndex = session.collaborators.findIndex(
            c => c.user.toString() === userId
        );

        if (collabIndex >= 0) {
            session.collaborators[collabIndex].role = role;
        } else {
            session.collaborators.push({ user: userId, role });
        }

        await session.save();
        await session.populate('collaborators.user', 'username');
        res.json({ message: `Role updated to ${role}`, collaborators: session.collaborators });
    } catch (err) {
        console.error('Set role error:', err);
        res.status(500).json({ error: 'Failed to set role' });
    }
});

// DELETE /api/sessions/:id — delete session (owner or admin)
router.delete('/:id', authMiddleware, async (req, res) => {
    try {
        const session = await Session.findOne({ sessionId: req.params.id });
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        const isOwner = session.owner.toString() === req.user.id;
        const isAdmin = req.user.role === 'admin';
        if (!isOwner && !isAdmin) {
            return res.status(403).json({ error: 'Only the owner or admin can delete this session' });
        }

        const ownerId = session.owner;
        await Session.deleteOne({ _id: session._id });
        
        // Check if owner was a guest and delete account if no sessions remain
        if (ownerId) {
            try {
                const User = require('../models/User');
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
                        console.log(`Deleted guest account after session deletion: ${user.username}`);
                    }
                }
            } catch (err) {
                console.error('Error cleaning up guest account:', err);
            }
        }
        
        res.json({ message: 'Session deleted' });
    } catch (err) {
        console.error('Delete session error:', err);
        res.status(500).json({ error: 'Failed to delete session' });
    }
});

module.exports = router;
