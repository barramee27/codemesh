const { normalizeUtf8Text } = require('./utf8');

function detectReferenceKind(originalName, mimeType) {
    const name = String(originalName || '').toLowerCase();
    const mime = String(mimeType || '').toLowerCase();
    if (mime.includes('pdf') || name.endsWith('.pdf')) return 'pdf';
    if (
        mime.includes('wordprocessingml')
        || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        || name.endsWith('.docx')
    ) {
        return 'docx';
    }
    if (mime.includes('msword') || name.endsWith('.doc')) return 'doc';
    return 'pdf';
}

function extensionForKind(kind) {
    if (kind === 'docx') return '.docx';
    if (kind === 'doc') return '.doc';
    return '.pdf';
}

/** Client-safe reference document payload from a Session document or plain object. */
function referencePdfForClient(session) {
    const rp = session && session.referencePdf;
    if (!rp || !rp.storageName) return null;
    const originalName = normalizeUtf8Text(rp.originalName) || 'reference.pdf';
    const mimeType = rp.mimeType || null;
    const kind = detectReferenceKind(originalName, mimeType);
    return {
        url: `/uploads/${rp.storageName}`,
        originalName,
        mimeType,
        kind,
        editedHtml: typeof rp.editedHtml === 'string' && rp.editedHtml ? rp.editedHtml : null
    };
}

module.exports = {
    referencePdfForClient,
    detectReferenceKind,
    extensionForKind
};
