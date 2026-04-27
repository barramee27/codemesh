/**
 * After authMiddleware: guests (@guest.codemesh.local) cannot use Clash play APIs.
 */
module.exports = function registeredUserOnly(req, res, next) {
    const email = req.user && req.user.email;
    if (!email || email.endsWith('@guest.codemesh.local')) {
        return res.status(403).json({
            error: 'Clash requires a registered account. Please sign up or log in (not guest mode).'
        });
    }
    next();
};
