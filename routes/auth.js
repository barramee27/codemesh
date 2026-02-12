const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';

// Admin credentials
const ADMIN_EMAIL = 'barramee25038@gmail.com';
const ADMIN_USERNAME = 'barramee27';

function generateToken(user) {
    return jwt.sign(
        { id: user._id, username: user.username, email: user.email, role: user.role },
        JWT_SECRET,
        { expiresIn: '7d' }
    );
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

        // Auto-assign admin role
        const isAdmin = (email.toLowerCase() === ADMIN_EMAIL || username.toLowerCase() === ADMIN_USERNAME.toLowerCase());

        const user = new User({
            username,
            email,
            passwordHash: password,
            role: isAdmin ? 'admin' : 'user'
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

        const valid = user.comparePassword(password);
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

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ error: 'No account found with that email' });
        }

        const password = user.getPassword();
        res.json({ message: 'Password recovered', password });
    } catch (err) {
        console.error('Forgot password error:', err);
        res.status(500).json({ error: 'Password recovery failed' });
    }
});

module.exports = router;
