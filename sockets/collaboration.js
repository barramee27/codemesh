const Session = require('../models/Session');
const User = require('../models/User');
const { transformOp, applyOp } = require('../utils/ot');
const { ensureSessionAccess } = require('../utils/sessionAccess');
const { referencePdfForClient } = require('../utils/sessionPdf');

// In-memory state for active sessions
const activeSessions = new Map();
// Map of sessionId -> save timeout
const saveTimers = new Map();

// ─── Performance constants ───
const MAX_USERS_PER_SESSION = (() => {
    const n = parseInt(process.env.MAX_USERS_PER_SESSION || '50', 10);
    if (Number.isNaN(n)) return 50;
    return Math.min(200, Math.max(1, n));
})();
const SAVE_DEBOUNCE_MS = 3000;
const SESSION_CLEANUP_DELAY_MS = 5000;
const SESSION_FINAL_CLEANUP_MS = 3000;
const HISTORY_MAX = 200;
const HISTORY_TRIM_TO = 100;
const CURSOR_THROTTLE_MS = 100;

function getOrCreateSessionState(sessionId) {
    if (!activeSessions.has(sessionId)) {
        activeSessions.set(sessionId, {
            files: new Map(), // fileId -> { doc, version, history }
            users: new Map(), // socketId -> { username, color, cursor, selection, userId, role, activeFileId }
            language: 'plaintext', // Default fallback (client resolves from name/content)
            comments: [], // { id, fileId, line, text, author, timestamp }
            chatMessages: [] // { id, userId, username, text, ts }
        });
    }
    return activeSessions.get(sessionId);
}

const USER_COLORS = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
    '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
    '#BB8FCE', '#85C1E9', '#F1948A', '#82E0AA'
];

function getColor(index) {
    return USER_COLORS[index % USER_COLORS.length];
}

function dbFilesToMemoryMap(dbFiles) {
    const map = new Map();
    (dbFiles || []).forEach((f) => {
        map.set(f.id, {
            id: f.id,
            name: f.name,
            doc: f.content != null ? String(f.content) : '',
            language: f.language || 'plaintext',
            version: 0,
            history: []
        });
    });
    return map;
}

/** Merge MongoDB file contents into live session memory (DB is source of truth when memory is empty). */
async function syncSessionFilesFromDatabase(sessionId, state) {
    const dbSession = await Session.findOne({ sessionId });
    if (!dbSession) return null;

    if (dbSession.files && dbSession.files.length > 0) {
        const dbMap = dbFilesToMemoryMap(dbSession.files);
        dbMap.forEach((dbFile, id) => {
            const mem = state.files.get(id);
            const memDoc = mem && mem.doc != null ? String(mem.doc) : '';
            state.files.set(id, {
                ...dbFile,
                version: mem ? mem.version : 0,
                history: mem ? mem.history : [],
                doc: memDoc.length > 0 ? memDoc : dbFile.doc
            });
        });
    } else if (dbSession.code) {
        const defaultFileId = 'main_file';
        const mem = state.files.get(defaultFileId);
        const memDoc = mem && mem.doc != null ? String(mem.doc) : '';
        state.files.set(defaultFileId, {
            id: defaultFileId,
            name: 'snippet.txt',
            doc: memDoc.length > 0 ? memDoc : (dbSession.code || ''),
            language: dbSession.language || 'plaintext',
            version: mem ? mem.version : 0,
            history: mem ? mem.history : []
        });
    }
    return dbSession;
}

// Helper function to check if user is guest and delete if no sessions remain
async function deleteGuestIfNoSessions(userId) {
    try {
        const user = await User.findById(userId);
        if (!user) return;
        
        // Check if user is a guest (email ends with @guest.codemesh.local)
        if (!user.email || !user.email.endsWith('@guest.codemesh.local')) {
            return; // Not a guest, skip
        }
        
        // Check if user has any remaining sessions (active or in DB)
        const dbSessions = await Session.find({ owner: userId });
        const hasActiveSessions = Array.from(activeSessions.values()).some(state => 
            Array.from(state.users.values()).some(u => u.userId === userId)
        );
        
        // If no sessions in DB and no active sessions, delete guest account
        if (dbSessions.length === 0 && !hasActiveSessions) {
            // Also remove from collaborators in other sessions
            await Session.updateMany(
                { 'collaborators.user': userId },
                { $pull: { collaborators: { user: userId } } }
            );
            
            await User.deleteOne({ _id: userId });
            console.log(`Deleted guest account: ${user.username} (${user.email})`);
        }
    } catch (err) {
        console.error('Error in deleteGuestIfNoSessions:', err);
    }
}

function scheduleSave(sessionId) {
    if (saveTimers.has(sessionId)) {
        clearTimeout(saveTimers.get(sessionId));
    }
    saveTimers.set(sessionId, setTimeout(async () => {
        const state = activeSessions.get(sessionId);
        if (!state) return;
        
        try {
            const filesToSave = Array.from(state.files.entries()).map(([id, fileData]) => ({
                id,
                name: fileData.name,
                content: fileData.doc,
                language: fileData.language
            }));

            await Session.findOneAndUpdate(
                { sessionId },
                { $set: { files: filesToSave, updatedAt: Date.now() } }
            );
        } catch (err) {
            console.error(`Auto-save error for ${sessionId}:`, err.message);
        }
        saveTimers.delete(sessionId);
    }, SAVE_DEBOUNCE_MS));
}

// ─── Save all active sessions immediately (for graceful shutdown) ───
async function saveAllSessions() {
    const promises = [];
    for (const [sessionId, state] of activeSessions.entries()) {
        if (saveTimers.has(sessionId)) {
            clearTimeout(saveTimers.get(sessionId));
            saveTimers.delete(sessionId);
        }
        
        const filesToSave = Array.from(state.files.entries()).map(([id, fileData]) => ({
            id,
            name: fileData.name,
            content: fileData.doc,
            language: fileData.language
        }));

        promises.push(
            Session.findOneAndUpdate(
                { sessionId },
                { $set: { files: filesToSave, updatedAt: Date.now() } }
            ).catch(err => console.error(`Shutdown save error for ${sessionId}:`, err.message))
        );
    }
    await Promise.all(promises);
}

// Per-socket cursor throttle tracking
const cursorTimestamps = new Map(); // socketId -> last cursor broadcast time

module.exports = function setupCollaboration(io) {
    io.on('connection', (socket) => {

        socket.on('join-session', async (data) => {
            const { sessionId, classKey } = data;
            if (!sessionId) return;

            // Use server-verified user from auth middleware (client values are ignored)
            const username = socket.user ? socket.user.username : 'Anonymous';
            const userId = socket.user ? socket.user.id : null;

            let verifiedDbSession = null;
            // Validate session access (public, owner, collab, admin, or class key)
            try {
                verifiedDbSession = await Session.findOne({ sessionId }).select('+classKeyHash');
                if (!verifiedDbSession) {
                    socket.emit('join-error', { message: 'Session not found' });
                    return;
                }
                const access = await ensureSessionAccess(verifiedDbSession, {
                    userId,
                    userRole: socket.user ? socket.user.role : null,
                    classKey
                });
                if (!access.ok) {
                    socket.emit('join-error', {
                        message: access.error,
                        code: access.code
                    });
                    return;
                }
                verifiedDbSession = access.session;
            } catch (err) {
                socket.emit('join-error', { message: 'Failed to verify session access' });
                return;
            }

            const state = getOrCreateSessionState(sessionId);

            // ─── Connection limit check ───
            if (state.users.size >= MAX_USERS_PER_SESSION) {
                socket.emit('join-error', {
                    message: `Session is full (max ${MAX_USERS_PER_SESSION} users). Please try again later.`
                });
                return;
            }

            socket.join(sessionId);
            socket.sessionId = sessionId;
            socket.username = username;
            socket.userId = userId;

            // Always merge file contents from MongoDB (fixes empty editor when memory was stale)
            let dbSession = null;
            try {
                dbSession = await syncSessionFilesFromDatabase(sessionId, state);
            } catch (err) {
                console.error('Load session error:', err.message);
            }

            // Determine the user's role in this session
            let userRole = 'editor'; // default for new users
            if (socket.user && socket.user.role === 'admin') {
                userRole = 'admin';
            } else if (!dbSession) {
                dbSession = verifiedDbSession;
            }

            if (userRole !== 'admin' && dbSession && userId) {
                if (dbSession.owner.toString() === userId) {
                    userRole = 'owner';
                } else {
                    const collab = dbSession.collaborators.find(
                        c => c.user.toString() === userId
                    );
                    if (collab) {
                        userRole = collab.role; // 'editor' or 'viewer'
                    }
                    // Also add as collaborator if not already
                    if (!collab) {
                        const joinRole = dbSession.defaultJoinRole === 'viewer' ? 'viewer' : 'editor';
                        dbSession.collaborators.push({ user: userId, role: joinRole });
                        await dbSession.save();
                        userRole = joinRole;
                    }
                }
            }

            const userColor = getColor(state.users.size);
            state.users.set(socket.id, {
                username: socket.username,
                color: userColor,
                cursor: null,
                selection: null,
                userId: userId,
                role: userRole,
                activeFileId: null
            });

            // Format files map for client
            const clientFiles = {};
            state.files.forEach((data, id) => {
                clientFiles[id] = {
                    id: data.id,
                    name: data.name,
                    doc: data.doc,
                    language: data.language,
                    version: data.version
                };
            });

            let defaultJoinRole = 'editor';
            let referencePdf = null;
            if (!dbSession) {
                try {
                    dbSession = await Session.findOne({ sessionId });
                } catch (err) { /* ignore */ }
            }
            if (dbSession) {
                defaultJoinRole = dbSession.defaultJoinRole === 'viewer' ? 'viewer' : 'editor';
                referencePdf = referencePdfForClient(dbSession);
            }

            // Send current state to joining client
            socket.emit('session-state', {
                files: clientFiles,
                users: Object.fromEntries(state.users),
                role: userRole,
                comments: state.comments,
                chatMessages: state.chatMessages || [],
                defaultJoinRole,
                referencePdf,
                pdfSplitVisible: !!referencePdf
            });

            // Notify others
            socket.to(sessionId).emit('user-joined', {
                socketId: socket.id,
                username: socket.username,
                color: userColor,
                role: userRole
            });
        });

        socket.on('code-change', (data) => {
            const { sessionId, fileId, op, version } = data;
            if (!sessionId || !fileId) return;

            const state = activeSessions.get(sessionId);
            if (!state) return;

            const file = state.files.get(fileId);
            if (!file) return;

            // Check if user is a viewer — reject edits
            const userInfo = state.users.get(socket.id);
            if (userInfo && userInfo.role === 'viewer') {
                socket.emit('readonly-error', {
                    message: 'You are in view-only mode. The session owner has restricted your editing.'
                });
                return;
            }

            // Transform against concurrent ops if needed
            let transformedOp = { ...op, clientId: socket.id };
            if (version < file.version) {
                const missed = file.history.slice(version);
                for (const pastOp of missed) {
                    if (pastOp.clientId === socket.id) continue;
                    transformedOp = transformOp(transformedOp, pastOp);
                    if (!transformedOp) return; // op was consumed
                }
            }

            // Apply to server doc
            file.doc = applyOp(file.doc, transformedOp);
            file.version++;
            transformedOp.version = file.version;
            file.history.push(transformedOp);

            // ─── Optimized history cap ───
            if (file.history.length > HISTORY_MAX) {
                file.history = file.history.slice(-HISTORY_TRIM_TO);
            }

            // Broadcast to others in the session (sender already has the change)
            socket.to(sessionId).emit('remote-change', {
                fileId,
                op: transformedOp,
                version: file.version,
                userId: socket.id
            });

            // Acknowledge to sender
            socket.emit('ack', { fileId, version: file.version });

            // Schedule auto-save
            scheduleSave(sessionId);
        });

        function userCanEditSession(state, socketId) {
            const u = state.users.get(socketId);
            if (!u) return false;
            return u.role === 'owner' || u.role === 'editor' || u.role === 'admin';
        }

        function clientFilesPayload(state) {
            const clientFiles = {};
            state.files.forEach((data, id) => {
                clientFiles[id] = {
                    id: data.id,
                    name: data.name,
                    doc: data.doc,
                    language: data.language,
                    version: data.version
                };
            });
            return clientFiles;
        }

        socket.on('reload-session-from-db', async (data) => {
            const { sessionId } = data;
            if (!sessionId || socket.sessionId !== sessionId) return;
            const state = activeSessions.get(sessionId);
            if (!state) return;
            try {
                const dbSession = await Session.findOne({ sessionId });
                if (!dbSession || !Array.isArray(dbSession.files)) return;
                state.files = dbFilesToMemoryMap(dbSession.files);
                io.to(sessionId).emit('session-files-reloaded', {
                    files: clientFilesPayload(state)
                });
            } catch (err) {
                console.error('reload-session-from-db:', err.message);
            }
        });

        // ─── File Management ───
        socket.on('create-file', (data) => {
            const { sessionId, name, language } = data;
            if (!sessionId || !name) return;

            const state = activeSessions.get(sessionId);
            if (!state) return;
            if (!userCanEditSession(state, socket.id)) {
                socket.emit('readonly-error', {
                    message: 'Viewers cannot create files. Ask the owner for editor access.'
                });
                return;
            }

            const fileId = 'file_' + Math.random().toString(36).substring(2, 9);
            
            state.files.set(fileId, {
                id: fileId,
                name: name,
                doc: '',
                language: language || 'plaintext',
                version: 0,
                history: []
            });

            io.to(sessionId).emit('file-created', {
                id: fileId,
                name: name,
                doc: '',
                language: language || 'plaintext'
            });
            scheduleSave(sessionId);
        });

        socket.on('delete-file', (data) => {
            const { sessionId, fileId } = data;
            if (!sessionId || !fileId) return;

            const state = activeSessions.get(sessionId);
            if (!state) return;
            if (!userCanEditSession(state, socket.id)) {
                socket.emit('readonly-error', { message: 'Viewers cannot delete files.' });
                return;
            }

            if (state.files.has(fileId)) {
                state.files.delete(fileId);
                io.to(sessionId).emit('file-deleted', { fileId });
                scheduleSave(sessionId);
            }
        });

        socket.on('rename-file', (data) => {
            const { sessionId, fileId, newName } = data;
            if (!sessionId || !fileId || !newName) return;

            const state = activeSessions.get(sessionId);
            if (!state) return;
            if (!userCanEditSession(state, socket.id)) {
                socket.emit('readonly-error', { message: 'Viewers cannot rename files.' });
                return;
            }

            const file = state.files.get(fileId);
            if (file) {
                file.name = newName;
                io.to(sessionId).emit('file-renamed', { fileId, newName });
                scheduleSave(sessionId);
            }
        });

        // Owner/admin can change a user's role live
        socket.on('set-user-role', async (data) => {
            const { sessionId, targetSocketId, role } = data;
            if (!sessionId || !targetSocketId || !['editor', 'viewer'].includes(role)) return;

            const state = activeSessions.get(sessionId);
            if (!state) return;

            const requester = state.users.get(socket.id);
            if (!requester || (requester.role !== 'owner' && requester.role !== 'admin')) return;

            const target = state.users.get(targetSocketId);
            if (!target || target.role === 'owner') return; // Can't change owner

            target.role = role;

            // Persist to DB
            if (target.userId) {
                try {
                    const dbSession = await Session.findOne({ sessionId });
                    if (dbSession) {
                        const collab = dbSession.collaborators.find(
                            c => c.user.toString() === target.userId
                        );
                        if (collab) {
                            collab.role = role;
                        } else {
                            dbSession.collaborators.push({ user: target.userId, role });
                        }
                        await dbSession.save();
                    }
                } catch (err) {
                    console.error('Set role DB error:', err.message);
                }
            }

            // Notify the affected user
            io.to(targetSocketId).emit('role-changed', {
                role,
                message: role === 'viewer'
                    ? 'View-only mode: you cannot edit. Only the session owner can copy or highlight code.'
                    : 'You can edit this session, but only the session owner can copy or highlight code.'
            });

            // Notify everyone about the role change
            io.to(sessionId).emit('user-role-updated', {
                socketId: targetSocketId,
                username: target.username,
                role
            });
        });

        // ─── Cursor updates with server-side throttling ───
        socket.on('cursor-update', (data) => {
            const { sessionId, fileId, cursor, selection } = data;
            if (!sessionId || !fileId) return;

            const state = activeSessions.get(sessionId);
            if (!state) return;

            const user = state.users.get(socket.id);
            if (user) {
                if (cursor) user.cursor = cursor;
                if (selection) user.selection = selection;
                user.activeFileId = fileId;
            }

            // Throttle cursor broadcasts to prevent flooding
            const now = Date.now();
            const lastBroadcast = cursorTimestamps.get(socket.id) || 0;
            if (now - lastBroadcast < CURSOR_THROTTLE_MS) return;
            cursorTimestamps.set(socket.id, now);

            socket.to(sessionId).emit('cursor-moved', {
                socketId: socket.id,
                username: socket.username,
                fileId,
                cursor,
                selection
            });
        });

        // ─── Comments ───
        socket.on('add-comment', (data) => {
            const { sessionId, fileId, line, text } = data;
            if (!sessionId || !fileId || !text) return;

            const state = activeSessions.get(sessionId);
            if (!state) return;

            const comment = {
                id: Math.random().toString(36).substring(2, 9),
                fileId,
                line,
                text,
                author: socket.username,
                timestamp: new Date().toISOString()
            };

            state.comments.push(comment);
            
            // Broadcast to everyone in the session
            io.to(sessionId).emit('comment-added', comment);
        });

        socket.on('language-change', (data) => {
            const { sessionId, fileId, language } = data;
            if (!sessionId || !fileId) return;

            const state = activeSessions.get(sessionId);
            if (state) {
                const file = state.files.get(fileId);
                if (file) {
                    file.language = language;
                    scheduleSave(sessionId);
                    socket.to(sessionId).emit('language-changed', {
                        fileId,
                        language,
                        userId: socket.id
                    });
                }
            }
        });

        socket.on('chat-message', (data) => {
            const { sessionId, text } = data;
            if (!sessionId || !text || typeof text !== 'string') return;
            const state = activeSessions.get(sessionId);
            if (!state) return;
            const userInfo = state.users.get(socket.id);
            const msg = {
                id: require('crypto').randomBytes(8).toString('hex'),
                userId: socket.user?.id || socket.id,
                username: userInfo?.username || socket.user?.username || 'Anonymous',
                text: text.trim().slice(0, 2000),
                ts: Date.now()
            };
            state.chatMessages = state.chatMessages || [];
            state.chatMessages.push(msg);
            if (state.chatMessages.length > 200) state.chatMessages = state.chatMessages.slice(-100);
            io.to(sessionId).emit('chat-message', msg);
        });

        socket.on('session-pdf-updated', (data) => {
            const { sessionId, referencePdf } = data || {};
            if (!sessionId || socket.sessionId !== sessionId) return;
            io.to(sessionId).emit('reference-pdf-changed', {
                referencePdf: referencePdf || null,
                pdfSplitVisible: !!referencePdf
            });
        });

        socket.on('set-join-policy', async (data) => {
            const { sessionId, defaultJoinRole } = data;
            if (!sessionId || !['editor', 'viewer'].includes(defaultJoinRole)) return;
            const mem = activeSessions.get(sessionId);
            if (!mem) return;
            const requester = mem.users.get(socket.id);
            if (!requester || (requester.role !== 'owner' && requester.role !== 'admin')) return;
            try {
                const dbSession = await Session.findOne({ sessionId });
                if (!dbSession) return;
                dbSession.defaultJoinRole = defaultJoinRole;
                await dbSession.save();
                io.to(sessionId).emit('join-policy-changed', { defaultJoinRole });
            } catch (err) {
                console.error('set-join-policy:', err.message);
            }
        });

        socket.on('request-state', async (data) => {
            const { sessionId } = data;
            if (!sessionId || socket.sessionId !== sessionId) return;
            const state = activeSessions.get(sessionId);
            if (!state) return;
            const userInfo = state.users.get(socket.id);
            if (!userInfo) return;
            const clientFiles = {};
            state.files.forEach((fileData, id) => {
                clientFiles[id] = {
                    id: fileData.id,
                    name: fileData.name,
                    doc: fileData.doc,
                    language: fileData.language,
                    version: fileData.version
                };
            });
            let defaultJoinRole = 'editor';
            let referencePdf = null;
            try {
                const dbSession = await Session.findOne({ sessionId });
                if (dbSession) {
                    defaultJoinRole = dbSession.defaultJoinRole === 'viewer' ? 'viewer' : 'editor';
                    referencePdf = referencePdfForClient(dbSession);
                }
            } catch (err) { /* ignore */ }
            socket.emit('session-state', {
                files: clientFiles,
                users: Object.fromEntries(state.users),
                role: userInfo.role,
                comments: state.comments,
                chatMessages: state.chatMessages || [],
                defaultJoinRole,
                referencePdf,
                pdfSplitVisible: !!referencePdf
            });
        });

        socket.on('disconnect', () => {
            const sessionId = socket.sessionId;
            if (!sessionId) return;

            // Clean up cursor throttle tracking
            cursorTimestamps.delete(socket.id);

            const state = activeSessions.get(sessionId);
            if (state) {
                state.users.delete(socket.id);

                socket.to(sessionId).emit('user-left', {
                    socketId: socket.id,
                    username: socket.username
                });

                // ─── Faster empty session cleanup ───
                if (state.users.size === 0) {
                    setTimeout(() => {
                        const currentState = activeSessions.get(sessionId);
                        if (currentState && currentState.users.size === 0) {
                            // Final save
                            scheduleSave(sessionId);
                            setTimeout(async () => {
                                const final = activeSessions.get(sessionId);
                                if (final && final.users.size === 0) {
                                    activeSessions.delete(sessionId);
                                    
                                    // Check if session owner was a guest and delete guest account if no sessions remain
                                    try {
                                        const dbSession = await Session.findOne({ sessionId });
                                        if (dbSession && dbSession.owner) {
                                            await deleteGuestIfNoSessions(dbSession.owner);
                                        }
                                    } catch (err) {
                                        console.error('Error checking guest cleanup:', err);
                                    }
                                }
                            }, SESSION_FINAL_CLEANUP_MS);
                        }
                    }, SESSION_CLEANUP_DELAY_MS);
                } else {
                    // Check if disconnecting user is a guest and delete account if no sessions remain
                    if (socket.userId) {
                        setTimeout(async () => {
                            try {
                                await deleteGuestIfNoSessions(socket.userId);
                            } catch (err) {
                                console.error('Error checking guest cleanup on disconnect:', err);
                            }
                        }, 1000); // Small delay to ensure session cleanup completes
                    }
                }
            }
        });
    });

    // Return saveAllSessions for graceful shutdown
    return { saveAllSessions };
};
