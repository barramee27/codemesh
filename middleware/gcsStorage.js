const multer = require('multer');
const path = require('path');
const { uploadFile, isConfigured } = require('../services/gcsService');

function decodeMultipartFilename(name) {
  const raw = String(name || '').trim();
  if (!raw) return raw;
  const decoded = Buffer.from(raw, 'latin1').toString('utf8');
  if (decoded.includes('\uFFFD') && !raw.includes('\uFFFD')) return raw;
  return decoded;
}

function safeStoredName(originalname) {
  const norm = decodeMultipartFilename(originalname).replace(/\\/g, '/');
  const base = path.basename(norm);
  if (!base || base === '.' || base === '..') return null;
  const unique = Date.now() + '-' + Math.random().toString(36).slice(2, 9);
  const safe = base.replace(/[^\w.\-()+ ]/g, '_').replace(/\s+/g, '_');
  return `${unique}-${safe}`;
}

const createGCSStorage = (folder) => ({
  _handleFile(req, file, cb) {
    if (!isConfigured()) {
      return cb(new Error('GCS storage is not configured.'));
    }

    const filename = safeStoredName(file.originalname);
    if (!filename) {
      return cb(new Error('Invalid filename'));
    }

    const destinationPath = `${folder}/${filename}`;
    const chunks = [];

    file.stream.on('data', (chunk) => chunks.push(chunk));
    file.stream.on('end', async () => {
      try {
        const buffer = Buffer.concat(chunks);
        const publicUrl = await uploadFile(buffer, destinationPath, file.mimetype || 'application/octet-stream');
        cb(null, {
          fieldname: file.fieldname,
          originalname: file.originalname,
          encoding: file.encoding,
          mimetype: file.mimetype,
          destination: folder,
          filename,
          path: destinationPath,
          size: buffer.length,
          url: publicUrl,
        });
      } catch (err) {
        cb(err);
      }
    });
    file.stream.on('error', cb);
  },

  _removeFile(_req, _file, cb) {
    cb(null);
  },
});

module.exports = { createGCSStorage };
