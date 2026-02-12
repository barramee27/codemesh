// Admin-only middleware — must be used AFTER authMiddleware
module.exports = function adminAuth(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
};
