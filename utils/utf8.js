/**
 * UTF-8 helpers — multer filenames, paths, and safe string normalization.
 */

/** Multer stores originalname as latin1 bytes; decode to UTF-8 (Thai filenames, etc.). */
function decodeMultipartFilename(name) {
    if (name == null || name === '') return '';
    try {
        return Buffer.from(String(name), 'latin1').toString('utf8');
    } catch (_) {
        return String(name);
    }
}

/** Safe decodeURIComponent for URL path segments. */
function decodePathSegment(segment) {
    if (segment == null || segment === '') return '';
    try {
        return decodeURIComponent(String(segment));
    } catch (_) {
        return String(segment);
    }
}

/**
 * Session / room slug: 3–50 chars, letters or numbers (any script), _ and - only.
 * No slashes, dots, or spaces (avoids URL/path confusion).
 */
const SESSION_ID_RE = /^[\p{L}\p{N}_-]{3,50}$/u;

function isValidSessionId(raw) {
    if (!raw || typeof raw !== 'string') return false;
    const s = raw.trim();
    if (!SESSION_ID_RE.test(s)) return false;
    const lower = s.toLowerCase();
    const reserved = new Set([
        'api', 'css', 'js', 'uploads', 'socket.io', 'reset-password', 'admin',
        'login', 'register', 'web', 'site', 'clash', 'c'
    ]);
    return !reserved.has(lower);
}

/** Normalize user-visible text from DB/API (already UTF-8); trim only. */
function normalizeUtf8Text(value) {
    if (value == null) return '';
    return String(value).normalize('NFC');
}

module.exports = {
    decodeMultipartFilename,
    decodePathSegment,
    SESSION_ID_RE,
    isValidSessionId,
    normalizeUtf8Text
};
