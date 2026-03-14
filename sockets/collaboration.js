const Session = require('../models/Session');
const { transformOp, applyOp } = require('../utils/ot');

// In-memory state for active sessions
const activeSessions = new Map();
// Map of sessionId -> save timeout
const saveTimers = new Map();

// ─── Performance constants ───
const MAX_USERS_PER_SESSION = 50;
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
            language: 'javascript', // Default fallback
            comments: [] // { id, fileId, line, text, author, timestamp }
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
            const { sessionId, username, userId } = data;
            if (!sessionId) return;

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
            socket.username = username || 'Anonymous';
            socket.userId = userId || null;

            // Load from DB if fresh
            let dbSession = null;
            if (state.users.size === 0) {
                try {
                    dbSession = await Session.findOne({ sessionId });
                    if (dbSession) {
                        // Migrate legacy single-file sessions to multi-file
                        if (!dbSession.files || dbSession.files.length === 0) {
                            const defaultFileId = 'main_file';
                            state.files.set(defaultFileId, {
                                id: defaultFileId,
                                name: 'main.js',
                                doc: dbSession.code || '',
                                language: dbSession.language || 'javascript',
                                version: 0,
                                history: []
                            });
                        } else {
                            dbSession.files.forEach(f => {
                                state.files.set(f.id, {
                                    id: f.id,
                                    name: f.name,
                                    doc: f.content || '',
                                    language: f.language || 'javascript',
                                    version: 0,
                                    history: []
                                });
                            });
                        }
                    }
                } catch (err) {
                    console.error('Load session error:', err.message);
                }
            }

            // Determine the user's role in this session
            let userRole = 'editor'; // default for new users
            if (!dbSession) {
                try {
                    dbSession = await Session.findOne({ sessionId });
                } catch (err) { /* ignore */ }
            }

            if (dbSession && userId) {
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
                        dbSession.collaborators.push({ user: userId, role: 'editor' });
                        await dbSession.save();
                        userRole = 'editor';
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

            // Send current state to joining client
            socket.emit('session-state', {
                files: clientFiles,
                users: Object.fromEntries(state.users),
                role: userRole,
                comments: state.comments
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

        // ─── File Management ───
        socket.on('create-file', (data) => {
            const { sessionId, name, language } = data;
            if (!sessionId || !name) return;

            const state = activeSessions.get(sessionId);
            if (!state) return;

            const fileId = 'file_' + Math.random().toString(36).substring(2, 9);
            
            state.files.set(fileId, {
                id: fileId,
                name: name,
                doc: '',
                language: language || 'javascript',
                version: 0,
                history: []
            });

            io.to(sessionId).emit('file-created', {
                id: fileId,
                name: name,
                doc: '',
                language: language || 'javascript'
            });
            scheduleSave(sessionId);
        });

        socket.on('delete-file', (data) => {
            const { sessionId, fileId } = data;
            if (!sessionId || !fileId) return;

            const state = activeSessions.get(sessionId);
            if (!state) return;

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
                    ? 'You have been set to view-only mode by the session owner'
                    : 'You now have editing permissions'
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
                            setTimeout(() => {
                                const final = activeSessions.get(sessionId);
                                if (final && final.users.size === 0) {
                                    activeSessions.delete(sessionId);
                                }
                            }, SESSION_FINAL_CLEANUP_MS);
                        }
                    }, SESSION_CLEANUP_DELAY_MS);
                }
            }
        });
    });

    // Return saveAllSessions for graceful shutdown
    return { saveAllSessions };
};
