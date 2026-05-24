const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const Session = require('../models/Session');
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');
const { fetchPublicRepoFiles, languageFromFilename, textLikeFile, shouldSkipPath } = require('../utils/githubImport');
const { MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES } = require('../utils/sessionImportLimits');

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const pdfUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, UPLOADS_DIR),
        filename: (req, file, cb) => {
            const sid = path.basename(req.params.id || 'session');
            cb(null, `session-${sid}-ref-${Date.now()}.pdf`);
        }
    }),
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname)) {
            cb(null, true);
        } else {
            cb(new Error('Only PDF files are allowed'));
        }
    }
});

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';

const router = express.Router();

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{3,50}$/;

function sessionCanEdit(session, userId, isAdmin) {
    if (isAdmin) return true;
    if (session.owner.toString() === userId) return true;
    const collab = session.collaborators.find((c) => c.user.toString() === userId);
    return !!(collab && collab.role === 'editor');
}

function sessionIsOwnerOrSiteAdmin(session, userId, isAdmin) {
    return isAdmin || session.owner.toString() === userId;
}

function referencePdfPayload(session) {
    if (!session.referencePdf || !session.referencePdf.storageName) return null;
    return {
        url: `/uploads/${session.referencePdf.storageName}`,
        originalName: session.referencePdf.originalName || 'reference.pdf'
    };
}

function attachSessionMeta(session) {
    const obj = session.toObject ? session.toObject() : { ...session };
    obj.referencePdf = referencePdfPayload(session);
    return obj;
}

function normalizeImportPath(name) {
    const n = String(name || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!n || n.includes('..')) return null;
    const parts = n.split('/').filter((p) => p && p !== '.');
    if (parts.some((p) => p === '..')) return null;
    return parts.join('/');
}

function normalizeImportedFileList(rawFiles) {
    if (!Array.isArray(rawFiles)) return [];
    const out = [];
    let totalBytes = 0;
    for (const item of rawFiles) {
        if (out.length >= MAX_FILES) break;
        const rel = normalizeImportPath(item && item.name);
        if (!rel || shouldSkipPath(rel) || !textLikeFile(rel)) continue;
        const content = String(item.content != null ? item.content : '');
        const bytes = Buffer.byteLength(content, 'utf8');
        if (bytes > MAX_FILE_BYTES) continue;
        if (totalBytes + bytes > MAX_TOTAL_BYTES) break;
        totalBytes += bytes;
        out.push({
            id: 'f_' + uuidv4().split('-')[0],
            name: rel,
            content,
            language: languageFromFilename(rel)
        });
    }
    return out;
}

// POST /api/sessions/join-or-create — load or create a public session by ID (shareable URLs like /A2-042)
router.post('/join-or-create', authMiddleware, async (req, res) => {
    try {
        const raw = (req.body.sessionId || '').trim();
        if (!SESSION_ID_RE.test(raw)) {
            return res.status(400).json({
                error: 'Session ID must be 3–50 characters: letters, numbers, _ or - only'
            });
        }

        let session = await Session.findOne({ sessionId: raw })
            .populate('owner', 'username')
            .populate('collaborators.user', 'username');

        if (session) {
            const isOwner = session.owner._id.toString() === req.user.id;
            const isCollab = session.collaborators.some(
                c => c.user && c.user._id.toString() === req.user.id
            );
            if (!session.isPublic && !isOwner && !isCollab) {
                return res.status(403).json({ error: 'This session is private' });
            }
            return res.json(session);
        }

        const fileId = 'f_' + uuidv4().split('-')[0];
        session = new Session({
            sessionId: raw,
            title: (req.body.title && String(req.body.title).trim()) || raw,
            language: 'plaintext',
            code: '',
            files: [{
                id: fileId,
                name: 'snippet.txt',
                content: '',
                language: 'plaintext'
            }],
            owner: req.user.id,
            isPublic: true
        });
        await session.save();
        await session.populate('owner', 'username');
        return res.status(201).json(session);
    } catch (err) {
        console.error('join-or-create error:', err);
        return res.status(500).json({ error: 'Failed to open or create session' });
    }
});

// POST /api/sessions — create new session
router.post('/', authMiddleware, async (req, res) => {
    try {
        const { title, language, customSessionId } = req.body;

        // Custom session ID validation
        let sessionId;
        if (customSessionId) {
            const cleanId = customSessionId.trim();
            if (!SESSION_ID_RE.test(cleanId)) {
                return res.status(400).json({
                    error: 'Custom ID must be 3-50 characters, alphanumeric with _ or - only'
                });
            }
            // Check uniqueness
            const existing = await Session.findOne({ sessionId: cleanId });
            if (existing) {
                return res.status(409).json({ error: 'This session ID is already taken' });
            }
            sessionId = cleanId;
        } else {
            sessionId = uuidv4().split('-')[0];
        }

        const session = new Session({
            sessionId,
            title: title || 'Untitled Session',
            language: language || 'plaintext',
            code: '',
            owner: req.user.id
        });
        await session.save();
        await session.populate('owner', 'username');
        res.status(201).json(session);
    } catch (err) {
        console.error('Create session error:', err);
        res.status(500).json({ error: 'Failed to create session' });
    }
});

// GET /api/sessions — list user's sessions
router.get('/', authMiddleware, async (req, res) => {
    try {
        const sessions = await Session.find({
            $or: [
                { owner: req.user.id },
                { 'collaborators.user': req.user.id }
            ]
        })
            .populate('owner', 'username')
            .sort({ updatedAt: -1 })
            .limit(50)
            .lean();

        res.json(sessions);
    } catch (err) {
        console.error('List sessions error:', err);
        res.status(500).json({ error: 'Failed to list sessions' });
    }
});

// POST /api/sessions/:id/import-github — append files from a public GitHub repo (owner/repo)
router.post('/:id/import-github', authMiddleware, async (req, res) => {
    try {
        const session = await Session.findOne({ sessionId: req.params.id });
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        if (!sessionCanEdit(session, req.user.id, req.user.role === 'admin')) {
            return res.status(403).json({ error: 'You need editor access to import files' });
        }

        const { repo, branch, subdir } = req.body;
        if (!repo || typeof repo !== 'string') {
            return res.status(400).json({ error: 'Body must include repo as "owner/name"' });
        }

        const { files: imported, truncated, branch: usedBranch } = await fetchPublicRepoFiles(
            repo,
            branch,
            subdir && String(subdir).trim() ? String(subdir).trim() : undefined
        );
        if (!imported.length) {
            return res.status(400).json({
                error: 'No suitable text files found (size/type limits), or repo is empty',
                truncated
            });
        }

        const existing = Array.isArray(session.files) ? [...session.files] : [];
        session.files = existing.concat(imported);
        session.updatedAt = Date.now();
        await session.save();
        await session.populate('owner', 'username');
        await session.populate('collaborators.user', 'username');

        res.json({
            message: `Imported ${imported.length} file(s) from ${String(repo).trim()}@${usedBranch}`,
            importedCount: imported.length,
            truncated,
            branch: usedBranch,
            session,
            reloadLive: true
        });
    } catch (err) {
        console.error('import-github error:', err.message);
        let status = 400;
        if (err.status === 404) status = 404;
        else if (String(err.message || '').toLowerCase().includes('rate limit')) status = 429;
        else if (typeof err.status === 'number' && err.status >= 400 && err.status < 500) status = err.status;
        res.status(status).json({ error: err.message || 'GitHub import failed' });
    }
});

// POST /api/sessions/:id/import-files — append files from local folder pick (browser → JSON)
router.post('/:id/import-files', authMiddleware, async (req, res) => {
    try {
        const session = await Session.findOne({ sessionId: req.params.id });
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        if (!sessionCanEdit(session, req.user.id, req.user.role === 'admin')) {
            return res.status(403).json({ error: 'You need editor access to import files' });
        }

        const imported = normalizeImportedFileList(req.body.files);
        if (!imported.length) {
            return res.status(400).json({
                error: 'No suitable text files (limits: 120 files, 5MB each, 50MB total)'
            });
        }

        const existing = Array.isArray(session.files) ? [...session.files] : [];
        session.files = existing.concat(imported);
        session.updatedAt = Date.now();
        await session.save();
        await session.populate('owner', 'username');
        await session.populate('collaborators.user', 'username');

        res.json({
            message: `Imported ${imported.length} file(s) into the workspace`,
            importedCount: imported.length,
            session,
            reloadLive: true
        });
    } catch (err) {
        console.error('import-files error:', err.message);
        res.status(500).json({ error: err.message || 'Import failed' });
    }
});

// GET /api/sessions/:id — get session by sessionId (auth required unless public)
router.get('/:id', async (req, res) => {
    try {
        const session = await Session.findOne({ sessionId: req.params.id })
            .populate('owner', 'username')
            .populate('collaborators.user', 'username');

        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        const authHeader = req.headers.authorization;
        const hasAuth = authHeader && authHeader.startsWith('Bearer ');
        let userId = null;
        if (hasAuth) {
            try {
                const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
                userId = decoded.id;
            } catch (e) { /* invalid token */ }
        }

        const isOwner = userId && session.owner._id.toString() === userId;
        const isCollab = userId && session.collaborators.some(c => c.user && c.user._id.toString() === userId);
        if (!session.isPublic && !isOwner && !isCollab) {
            if (!userId) {
                return res.status(401).json({ error: 'Authentication required' });
            }
            return res.status(403).json({ error: 'You do not have access to this session' });
        }

        res.json(session);
    } catch (err) {
        console.error('Get session error:', err);
        res.status(500).json({ error: 'Failed to get session' });
    }
});

// PUT /api/sessions/:id — update session
router.put('/:id', authMiddleware, async (req, res) => {
    try {
        const session = await Session.findOne({ sessionId: req.params.id });
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }
        if (!sessionCanEdit(session, req.user.id, req.user.role === 'admin')) {
            return res.status(403).json({ error: 'Viewers cannot save session changes' });
        }

        const { code, title, language, files } = req.body;
        const update = {};
        if (code !== undefined) update.code = code;
        if (title !== undefined) update.title = title;
        if (language !== undefined) update.language = language;
        if (files !== undefined && Array.isArray(files)) update.files = files;
        update.updatedAt = Date.now();

        const updated = await Session.findOneAndUpdate(
            { sessionId: req.params.id },
            { $set: update },
            { new: true }
        ).populate('owner', 'username');

        if (!updated) {
            return res.status(404).json({ error: 'Session not found' });
        }

        res.json(updated);
    } catch (err) {
        console.error('Update session error:', err);
        res.status(500).json({ error: 'Failed to update session' });
    }
});

// PUT /api/sessions/:id/join-policy — default role for new guests (owner or site admin)
router.put('/:id/join-policy', authMiddleware, async (req, res) => {
    try {
        const role = String(req.body.defaultJoinRole || '').toLowerCase();
        if (!['editor', 'viewer'].includes(role)) {
            return res.status(400).json({ error: 'defaultJoinRole must be editor or viewer' });
        }
        const session = await Session.findOne({ sessionId: req.params.id });
        if (!session) return res.status(404).json({ error: 'Session not found' });
        if (!sessionIsOwnerOrSiteAdmin(session, req.user.id, req.user.role === 'admin')) {
            return res.status(403).json({ error: 'Only the session owner or site admin can change join policy' });
        }
        session.defaultJoinRole = role;
        session.updatedAt = Date.now();
        await session.save();
        res.json({
            message: `New guests will join as ${role}`,
            defaultJoinRole: role,
            session: attachSessionMeta(session)
        });
    } catch (err) {
        console.error('join-policy error:', err);
        res.status(500).json({ error: 'Failed to update join policy' });
    }
});

// POST /api/sessions/:id/pdf — attach reference PDF for split view
router.post('/:id/pdf', authMiddleware, pdfUpload.single('pdf'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });
        const session = await Session.findOne({ sessionId: req.params.id });
        if (!session) {
            fs.unlink(req.file.path, () => {});
            return res.status(404).json({ error: 'Session not found' });
        }
        if (!sessionIsOwnerOrSiteAdmin(session, req.user.id, req.user.role === 'admin')) {
            fs.unlink(req.file.path, () => {});
            return res.status(403).json({ error: 'Only the session owner or site admin can attach a PDF' });
        }
        if (session.referencePdf && session.referencePdf.storageName) {
            const oldPath = path.join(UPLOADS_DIR, session.referencePdf.storageName);
            if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }
        session.referencePdf = {
            storageName: req.file.filename,
            originalName: req.file.originalname,
            uploadedAt: new Date()
        };
        session.updatedAt = Date.now();
        await session.save();
        res.json({
            message: 'PDF attached for split view',
            referencePdf: referencePdfPayload(session)
        });
    } catch (err) {
        console.error('session pdf upload:', err);
        res.status(500).json({ error: err.message || 'Failed to upload PDF' });
    }
});

// DELETE /api/sessions/:id/pdf
router.delete('/:id/pdf', authMiddleware, async (req, res) => {
    try {
        const session = await Session.findOne({ sessionId: req.params.id });
        if (!session) return res.status(404).json({ error: 'Session not found' });
        if (!sessionIsOwnerOrSiteAdmin(session, req.user.id, req.user.role === 'admin')) {
            return res.status(403).json({ error: 'Only the session owner or site admin can remove the PDF' });
        }
        if (session.referencePdf && session.referencePdf.storageName) {
            const p = path.join(UPLOADS_DIR, session.referencePdf.storageName);
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }
        session.referencePdf = undefined;
        session.updatedAt = Date.now();
        await session.save();
        res.json({ message: 'PDF removed', referencePdf: null });
    } catch (err) {
        console.error('session pdf delete:', err);
        res.status(500).json({ error: 'Failed to remove PDF' });
    }
});

// PUT /api/sessions/:id/role — set collaborator role (owner or admin only)
router.put('/:id/role', authMiddleware, async (req, res) => {
    try {
        const { userId, role } = req.body;

        if (!userId || !['editor', 'viewer'].includes(role)) {
            return res.status(400).json({ error: 'userId and role (editor/viewer) required' });
        }

        const session = await Session.findOne({ sessionId: req.params.id });
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        // Only owner or admin can change roles
        const isOwner = session.owner.toString() === req.user.id;
        const isAdmin = req.user.role === 'admin';
        if (!isOwner && !isAdmin) {
            return res.status(403).json({ error: 'Only the session owner or admin can change roles' });
        }

        // Find or add collaborator
        const collabIndex = session.collaborators.findIndex(
            c => c.user.toString() === userId
        );

        if (collabIndex >= 0) {
            session.collaborators[collabIndex].role = role;
        } else {
            session.collaborators.push({ user: userId, role });
        }

        await session.save();
        await session.populate('collaborators.user', 'username');
        res.json({ message: `Role updated to ${role}`, collaborators: session.collaborators });
    } catch (err) {
        console.error('Set role error:', err);
        res.status(500).json({ error: 'Failed to set role' });
    }
});

// DELETE /api/sessions/:id — delete session (owner or admin)
router.delete('/:id', authMiddleware, async (req, res) => {
    try {
        const session = await Session.findOne({ sessionId: req.params.id });
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        const isOwner = session.owner.toString() === req.user.id;
        const isAdmin = req.user.role === 'admin';
        if (!isOwner && !isAdmin) {
            return res.status(403).json({ error: 'Only the owner or admin can delete this session' });
        }

        const ownerId = session.owner;
        await Session.deleteOne({ _id: session._id });
        
        // Check if owner was a guest and delete account if no sessions remain
        if (ownerId) {
            try {
                const User = require('../models/User');
                const user = await User.findById(ownerId);
                if (user && user.email && user.email.endsWith('@guest.codemesh.local')) {
                    const remainingSessions = await Session.find({ owner: ownerId });
                    if (remainingSessions.length === 0) {
                        // Remove from collaborators in other sessions
                        await Session.updateMany(
                            { 'collaborators.user': ownerId },
                            { $pull: { collaborators: { user: ownerId } } }
                        );
                        await User.deleteOne({ _id: ownerId });
                        console.log(`Deleted guest account after session deletion: ${user.username}`);
                    }
                }
            } catch (err) {
                console.error('Error cleaning up guest account:', err);
            }
        }
        
        res.json({ message: 'Session deleted' });
    } catch (err) {
        console.error('Delete session error:', err);
        res.status(500).json({ error: 'Failed to delete session' });
    }
});

module.exports = router;
