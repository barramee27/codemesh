const jwt = require('jsonwebtoken');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';

/** Sets req.user when Bearer token is valid; otherwise req.user is undefined. */
module.exports = async function optionalAuth(req, res, next) {
    delete req.user;
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return next();
    }
    const token = header.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await User.findById(decoded.id).select('username email role banned');
        if (!user || user.banned) return next();
        req.user = {
            id: user._id.toString(),
            username: user.username,
            email: user.email,
            role: user.role
        };
    } catch (_) {
        /* invalid token — treat as anonymous */
    }
    next();
};
