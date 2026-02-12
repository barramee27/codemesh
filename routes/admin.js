const express = require('express');
const User = require('../models/User');
const Session = require('../models/Session');
const authMiddleware = require('../middleware/auth');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();

// All admin routes require auth + admin role
router.use(authMiddleware, adminAuth);

// GET /api/admin/users — list all users
router.get('/users', async (req, res) => {
    try {
        const users = await User.find()
            .select('username email role banned createdAt')
            .sort({ createdAt: -1 });

        // Count sessions per user
        const usersWithStats = await Promise.all(users.map(async (u) => {
            const sessionCount = await Session.countDocuments({ owner: u._id });
            return { ...u.toJSON(), sessionCount };
        }));

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
            .limit(100);
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

        await Session.deleteOne({ _id: session._id });
        res.json({ message: `Session "${session.title}" deleted` });
    } catch (err) {
        console.error('Admin delete session error:', err);
        res.status(500).json({ error: 'Failed to delete session' });
    }
});

module.exports = router;
