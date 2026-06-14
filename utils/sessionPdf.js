const { normalizeUtf8Text } = require('./utf8');

/** Client-safe reference PDF payload from a Session document or plain object. */
function referencePdfForClient(session) {
    const rp = session && session.referencePdf;
    if (!rp || !rp.storageName) return null;
    return {
        url: `/uploads/${rp.storageName}`,
        originalName: normalizeUtf8Text(rp.originalName) || 'reference.pdf'
    };
}

module.exports = { referencePdfForClient };
