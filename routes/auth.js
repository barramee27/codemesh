const express = require('express');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');
const User = require('../models/User');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
const APP_URL = process.env.APP_URL || 'https://codemesh.org';
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

if (process.env.NODE_ENV === 'production' && !JWT_SECRET) {
    console.error('FATAL: JWT_SECRET is required in production');
    process.exit(1);
}

function getJwtSecret() {
    return JWT_SECRET || 'fallback_secret';
}

function generateToken(user) {
    return jwt.sign(
        { id: user._id, username: user.username, email: user.email, role: user.role },
        getJwtSecret(),
        { expiresIn: '7d' }
    );
}

function isAdmin(email, username) {
    const e = (email || '').toLowerCase();
    const u = (username || '').toLowerCase();
    return ADMIN_EMAILS.some(a => a === e || a === u);
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({ error: 'All fields are required' });
        }
        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        const existingUser = await User.findOne({ $or: [{ email }, { username }] });
        if (existingUser) {
            return res.status(409).json({ error: 'Username or email already taken' });
        }

        const user = new User({
            username,
            email,
            passwordHash: password,
            role: isAdmin(email, username) ? 'admin' : 'user'
        });
        await user.save();

        const token = generateToken(user);
        res.status(201).json({ token, user: user.toJSON() });
    } catch (err) {
        console.error('Register error:', err);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }

        const user = await User.findOne({ email });
        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        if (user.banned) {
            return res.status(403).json({ error: 'Your account has been banned' });
        }

        const valid = await user.comparePassword(password);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = generateToken(user);
        res.json({ token, user: user.toJSON() });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Login failed' });
    }
});

// POST /api/auth/guest — create guest session (no account needed)
router.post('/guest', async (req, res) => {
    try {
        const guestId = 'guest-' + uuidv4().slice(0, 8);
        const username = 'Guest_' + guestId.slice(-6);

        const user = new User({
            username,
            email: `${guestId}@guest.codemesh.local`,
            passwordHash: uuidv4(),
            role: 'user'
        });
        await user.save();

        const token = generateToken(user);
        res.status(201).json({
            token,
            user: { ...user.toJSON(), guest: true }
        });
    } catch (err) {
        console.error('Guest auth error:', err);
        res.status(500).json({ error: 'Failed to start guest session' });
    }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        const user = await User.findOne({ email });
        if (user && resend) {
            const token = user.createResetToken();
            await user.save({ validateBeforeSave: false });

            const resetUrl = `${APP_URL}/reset-password?token=${token}`;
            await resend.emails.send({
                from: 'CodeMesh <noreply@codemesh.org>',
                to: user.email,
                subject: 'Reset your CodeMesh password',
                html: `
                    <p>You requested a password reset for your CodeMesh account.</p>
                    <p><a href="${resetUrl}" style="color:#6C5CE7;">Reset password</a></p>
                    <p>This link expires in 1 hour. If you didn't request this, ignore this email.</p>
                `
            });
        }

        res.json({ message: 'If an account exists, a reset link has been sent' });
    } catch (err) {
        console.error('Forgot password error:', err);
        res.status(500).json({ error: 'Password recovery failed' });
    }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
    try {
        const { token, newPassword } = req.body;

        if (!token || !newPassword) {
            return res.status(400).json({ error: 'Token and new password are required' });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        const user = await User.findOne({
            resetToken: token,
            resetTokenExpiry: { $gt: new Date() }
        });

        if (!user) {
            return res.status(400).json({ error: 'Invalid or expired reset link' });
        }

        user.passwordHash = newPassword;
        user.clearResetToken();
        await user.save();

        res.json({ message: 'Password reset successfully. You can now sign in.' });
    } catch (err) {
        console.error('Reset password error:', err);
        res.status(500).json({ error: 'Password reset failed' });
    }
});

module.exports = router;
