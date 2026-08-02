const express = require('express');
const multer = require('multer');
const { createGCSStorage } = require('../middleware/gcsStorage');
const { authMiddleware, uploadAuth, canUploadUser } = require('../middleware/uploadAuth');
const { isConfigured, listFiles, deleteFile } = require('../services/gcsService');

const router = express.Router();

const GCS_PREFIX = (process.env.GCS_UPLOAD_PREFIX || 'codemesh').replace(/\/+$/, '');
const MAX_MB = Number(process.env.UPLOAD_MAX_MB || 150);

const storage = isConfigured() ? createGCSStorage(GCS_PREFIX) : multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: MAX_MB * 1024 * 1024 },
});

router.get('/me', authMiddleware, (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      username: req.user.username,
      email: req.user.email,
      role: req.user.role,
    },
    canUpload: canUploadUser(req.user),
    gcsConfigured: isConfigured(),
    maxMb: MAX_MB,
    prefix: GCS_PREFIX,
  });
});

router.use(authMiddleware, uploadAuth);

router.get('/files', async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ error: 'GCS is not configured on this server.' });
    }
    const files = await listFiles(`${GCS_PREFIX}/`);
    res.json(files);
  } catch (err) {
    console.error('Upload list error:', err);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

router.post('/', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `File too large. Maximum size is ${MAX_MB} MB.` });
      }
      console.error('Upload multer error:', err);
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    res.status(201).json({
      message: 'File uploaded',
      file: {
        name: req.file.filename,
        path: req.file.path,
        size: req.file.size,
        url: req.file.url,
        mimetype: req.file.mimetype,
      },
    });
  });
});

router.delete('/files/:name', async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ error: 'GCS is not configured.' });
    }

    const rel = String(req.params.name || '').replace(/^\/+/, '');
    if (!rel || rel.includes('..') || rel.includes('/')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    const fullPath = `${GCS_PREFIX}/${rel}`;
    await deleteFile(fullPath);
    res.json({ message: 'File deleted', path: fullPath });
  } catch (err) {
    console.error('Upload delete error:', err);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

module.exports = router;
