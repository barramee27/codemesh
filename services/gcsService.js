const { Storage } = require('@google-cloud/storage');
const path = require('path');
const fs = require('fs');

let storage;
let bucketName;

try {
  bucketName = process.env.GCS_BUCKET_NAME;

  if (!bucketName) {
    console.warn('⚠️  GCS_BUCKET_NAME not set. Google Cloud Storage will not be available.');
  } else {
    let keyFilePath = process.env.GCS_KEY_FILE;

    if (keyFilePath && !fs.existsSync(keyFilePath)) {
      console.warn(`⚠️  GCS_KEY_FILE not found: ${keyFilePath}`);
      keyFilePath = null;
    }

    if (keyFilePath) {
      storage = new Storage({
        keyFilename: keyFilePath,
        projectId: process.env.GCS_PROJECT_ID,
      });
    } else if (
      process.env.GCS_PROJECT_ID &&
      process.env.GCS_CLIENT_EMAIL &&
      process.env.GCS_PRIVATE_KEY
    ) {
      storage = new Storage({
        projectId: process.env.GCS_PROJECT_ID,
        credentials: {
          client_email: process.env.GCS_CLIENT_EMAIL,
          private_key: process.env.GCS_PRIVATE_KEY.replace(/\\n/g, '\n'),
        },
      });
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      storage = new Storage({
        keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
        projectId: process.env.GCS_PROJECT_ID,
      });
    } else {
      storage = new Storage({ projectId: process.env.GCS_PROJECT_ID });
    }

    console.log('✅ Google Cloud Storage initialized. Bucket:', bucketName);
  }
} catch (error) {
  console.error('❌ GCS init error:', error.message);
}

const uploadFile = async (fileBuffer, destinationPath, contentType = 'application/octet-stream') => {
  if (!storage || !bucketName) {
    throw new Error('Google Cloud Storage is not configured.');
  }

  const file = storage.bucket(bucketName).file(destinationPath);
  await file.save(fileBuffer, {
    metadata: {
      contentType,
      cacheControl: 'public, max-age=31536000',
    },
    resumable: fileBuffer.length > 5 * 1024 * 1024,
  });

  return getPublicUrl(destinationPath);
};

const deleteFile = async (filePath) => {
  if (!storage || !bucketName) return;
  try {
    await storage.bucket(bucketName).file(filePath).delete();
  } catch (error) {
    if (error.code !== 404) throw error;
  }
};

const getPublicUrl = (filePath) => {
  if (!bucketName) return null;
  return `https://storage.googleapis.com/${bucketName}/${filePath}`;
};

const listFiles = async (prefix, maxResults = 300) => {
  if (!storage || !bucketName) {
    throw new Error('Google Cloud Storage is not configured.');
  }

  const [files] = await storage.bucket(bucketName).getFiles({
    prefix,
    maxResults,
  });

  return files
    .filter((f) => !f.name.endsWith('/'))
    .map((f) => ({
      path: f.name,
      name: f.name.slice(prefix.length),
      size: Number(f.metadata.size || 0),
      uploadedAt: f.metadata.updated || f.metadata.timeCreated,
      url: getPublicUrl(f.name),
    }))
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
};

const isConfigured = () => !!(storage && bucketName);

module.exports = {
  uploadFile,
  deleteFile,
  getPublicUrl,
  listFiles,
  isConfigured,
  bucketName,
};
