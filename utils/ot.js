/**
 * Lightweight Operational Transform utilities.
 * Operations are simple { type: 'insert'|'delete', pos, text|count } objects.
 */

function transformOp(opA, opB) {
    // Transform opA against opB so opA can be applied after opB
    const a = { ...opA };

    if (opB.type === 'insert') {
        if (a.type === 'insert') {
            if (a.pos > opB.pos || (a.pos === opB.pos && a.clientId > opB.clientId)) {
                a.pos += opB.text.length;
            }
        } else if (a.type === 'delete') {
            if (a.pos >= opB.pos) {
                a.pos += opB.text.length;
            }
        }
    } else if (opB.type === 'delete') {
        if (a.type === 'insert') {
            if (a.pos > opB.pos) {
                a.pos -= Math.min(opB.count, a.pos - opB.pos);
            }
        } else if (a.type === 'delete') {
            if (a.pos >= opB.pos + opB.count) {
                a.pos -= opB.count;
            } else if (a.pos >= opB.pos) {
                const overlap = Math.min(a.count, opB.pos + opB.count - a.pos);
                a.pos = opB.pos;
                a.count -= overlap;
                if (a.count <= 0) return null; // op was fully consumed
            } else {
                const overlap = Math.min(a.pos + a.count - opB.pos, opB.count);
                if (overlap > 0) {
                    a.count -= overlap;
                    if (a.count <= 0) return null;
                }
            }
        }
    }

    return a;
}

function applyOp(doc, op) {
    if (op.type === 'insert') {
        const pos = Math.min(op.pos, doc.length);
        return doc.slice(0, pos) + op.text + doc.slice(pos);
    } else if (op.type === 'delete') {
        const pos = Math.min(op.pos, doc.length);
        const count = Math.min(op.count, doc.length - pos);
        return doc.slice(0, pos) + doc.slice(pos + count);
    }
    return doc;
}

module.exports = { transformOp, applyOp };
