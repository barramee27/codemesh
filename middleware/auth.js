const jwt = require('jsonwebtoken');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';

module.exports = async function authMiddleware(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    const token = header.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);

        // Lookup user to check banned status and get current role
        const user = await User.findById(decoded.id).select('username email role banned');
        if (!user) {
            return res.status(401).json({ error: 'User no longer exists' });
        }
        if (user.banned) {
            return res.status(403).json({ error: 'Your account has been banned' });
        }

        req.user = {
            id: user._id.toString(),
            username: user.username,
            email: user.email,
            role: user.role
        };
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
};
