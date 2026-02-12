const express = require('express');
const { v4: uuidv4 } = require('uuid');
const Session = require('../models/Session');
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// POST /api/sessions — create new session
router.post('/', authMiddleware, async (req, res) => {
    try {
        const { title, language, customSessionId } = req.body;

        // Custom session ID validation
        let sessionId;
        if (customSessionId) {
            const cleanId = customSessionId.trim();
            if (!/^[a-zA-Z0-9_-]{3,20}$/.test(cleanId)) {
                return res.status(400).json({
                    error: 'Custom ID must be 3-20 characters, alphanumeric with _ or - only'
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
            .limit(50);

        res.json(sessions);
    } catch (err) {
        console.error('List sessions error:', err);
        res.status(500).json({ error: 'Failed to list sessions' });
    }
});

// GET /api/sessions/:id — get session by sessionId
router.get('/:id', async (req, res) => {
    try {
        const session = await Session.findOne({ sessionId: req.params.id })
            .populate('owner', 'username')
            .populate('collaborators.user', 'username');

        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
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
        const { code, title, language } = req.body;
        const update = {};
        if (code !== undefined) update.code = code;
        if (title !== undefined) update.title = title;
        if (language !== undefined) update.language = language;
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

        await Session.deleteOne({ _id: session._id });
        res.json({ message: 'Session deleted' });
    } catch (err) {
        console.error('Delete session error:', err);
        res.status(500).json({ error: 'Failed to delete session' });
    }
});

module.exports = router;
