const authMiddleware = require('./auth');

const ALLOWED_USER_IDS = (process.env.UPLOAD_ALLOWED_USER_IDS || '6a12d71adf110c76b8e43914')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function canUploadUser(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return ALLOWED_USER_IDS.includes(user.id);
}

function uploadAuth(req, res, next) {
  if (!canUploadUser(req.user)) {
    return res.status(403).json({ error: 'You do not have permission to use the upload portal.' });
  }
  next();
}

module.exports = {
  authMiddleware,
  uploadAuth,
  canUploadUser,
  ALLOWED_USER_IDS,
};
