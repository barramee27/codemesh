const bcrypt = require('bcryptjs');
const { referencePdfForClient } = require('./sessionPdf');

const CLASS_KEY_MIN = 4;
const CLASS_KEY_MAX = 64;

function isSiteAdmin(userRole) {
    return userRole === 'admin';
}

function isSessionOwner(session, userId) {
    if (!session || !userId) return false;
    const ownerId = session.owner._id ? session.owner._id.toString() : session.owner.toString();
    return ownerId === userId.toString();
}

function isCollaborator(session, userId) {
    if (!session || !userId) return false;
    return (session.collaborators || []).some((c) => {
        const uid = c.user && c.user._id ? c.user._id.toString() : c.user.toString();
        return uid === userId.toString();
    });
}

function hasKeyGrant(session, userId) {
    if (!session || !userId) return false;
    return (session.keyAccess || []).some((id) => id.toString() === userId.toString());
}

/** Owner, site admin, collaborator, public session, or prior class-key grant. */
function canAccessSession(session, userId, userRole) {
    if (!session) return false;
    if (isSiteAdmin(userRole)) return true;
    if (!userId) return false;
    if (isSessionOwner(session, userId)) return true;
    if (isCollaborator(session, userId)) return true;
    if (hasKeyGrant(session, userId)) return true;
    if (session.isPublic !== false) return true;
    return false;
}

function needsClassKey(session, userId, userRole) {
    if (!session || session.isPublic !== false) return false;
    return !canAccessSession(session, userId, userRole);
}

async function hashClassKey(classKey) {
    const key = String(classKey || '').trim();
    if (key.length < CLASS_KEY_MIN || key.length > CLASS_KEY_MAX) {
        throw new Error(`Class key must be ${CLASS_KEY_MIN}–${CLASS_KEY_MAX} characters`);
    }
    return bcrypt.hash(key, 10);
}

async function verifyClassKey(session, classKey) {
    if (!session || !session.classKeyHash) return false;
    const key = String(classKey || '').trim();
    if (!key) return false;
    return bcrypt.compare(key, session.classKeyHash);
}

async function grantKeyAccess(session, userId) {
    if (!userId) return;
    if (!session.keyAccess) session.keyAccess = [];
    const uid = userId.toString();
    if (!session.keyAccess.some((id) => id.toString() === uid)) {
        session.keyAccess.push(userId);
    }
}

function canViewSessionCode(session, userId, userRole) {
    if (!session) return false;
    if (isSiteAdmin(userRole)) return true;
    if (!userId) return false;
    if (isSessionOwner(session, userId)) return true;
    if (!session.guestCodeVisibleUntil) return true;
    return new Date() < new Date(session.guestCodeVisibleUntil);
}

function getGuestCodeVisibilityInfo(session) {
    if (!session || !session.guestCodeVisibleUntil) {
        return { status: 'forever', expiresAt: null, remainingMs: null };
    }
    const expiresAt = new Date(session.guestCodeVisibleUntil);
    const remainingMs = expiresAt.getTime() - Date.now();
    if (remainingMs > 0) {
        return { status: 'visible', expiresAt, remainingMs };
    }
    return { status: 'hidden', expiresAt, remainingMs: 0 };
}

function redactSessionCodeForClient(obj) {
    if (obj.files && Array.isArray(obj.files)) {
        obj.files = obj.files.map((f) => ({ ...f, content: '' }));
    }
    obj.code = '';
    obj.codeHiddenFromGuest = true;
}

function sanitizeSessionForClient(session, viewer) {
    const obj = session.toObject ? session.toObject() : { ...session };
    delete obj.classKeyHash;
    obj.requiresClassKey = session.isPublic === false;
    obj.hasClassKey = !!session.classKeyHash;
    obj.referencePdf = referencePdfForClient(session);
    obj.guestCodeVisibleUntil = session.guestCodeVisibleUntil || null;
    obj.guestCodeVisibility = getGuestCodeVisibilityInfo(session);

    if (viewer && !canViewSessionCode(session, viewer.userId, viewer.userRole)) {
        redactSessionCodeForClient(obj);
    }
    return obj;
}

function redactClientFiles(filesMap) {
    const out = {};
    for (const [id, fileData] of Object.entries(filesMap || {})) {
        out[id] = {
            ...fileData,
            doc: '',
            content: ''
        };
    }
    return out;
}

/**
 * Enforce private session + class key. Mutates session (grants access) on success.
 * @returns {{ ok: true, session }} | {{ ok: false, status, error, code? }}
 */
async function ensureSessionAccess(session, { userId, userRole, classKey }) {
    if (!session) {
        return { ok: false, status: 404, error: 'Session not found' };
    }

    if (!needsClassKey(session, userId, userRole)) {
        return { ok: true, session };
    }

    if (!classKey || !String(classKey).trim()) {
        return {
            ok: false,
            status: 403,
            error: 'This session is private. Enter the class key to join.',
            code: 'CLASS_KEY_REQUIRED',
            requiresClassKey: true
        };
    }

    const withHash = session.classKeyHash
        ? session
        : await session.constructor.findOne({ sessionId: session.sessionId }).select('+classKeyHash');

    if (!withHash || !withHash.classKeyHash) {
        return {
            ok: false,
            status: 403,
            error: 'This session is private but no class key is configured. Ask the session owner.',
            code: 'CLASS_KEY_NOT_SET'
        };
    }

    const valid = await verifyClassKey(withHash, classKey);
    if (!valid) {
        return {
            ok: false,
            status: 403,
            error: 'Invalid class key',
            code: 'CLASS_KEY_INVALID'
        };
    }

    await grantKeyAccess(withHash, userId);
    await withHash.save();
    return { ok: true, session: withHash };
}

module.exports = {
    CLASS_KEY_MIN,
    CLASS_KEY_MAX,
    isSiteAdmin,
    isSessionOwner,
    sessionIsOwnerOrSiteAdmin: (session, userId, isAdmin) =>
        isAdmin || isSessionOwner(session, userId),
    canAccessSession,
    canViewSessionCode,
    getGuestCodeVisibilityInfo,
    redactClientFiles,
    needsClassKey,
    hashClassKey,
    verifyClassKey,
    grantKeyAccess,
    sanitizeSessionForClient,
    ensureSessionAccess
};
