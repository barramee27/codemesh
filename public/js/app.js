/* ═══════════════════════════════════════════════
   CodeMesh — Main Application Controller
   ═══════════════════════════════════════════════ */

(function () {
    'use strict';

    // ─── State ───
    const state = {
        token: localStorage.getItem('codemesh_token'),
        user: JSON.parse(localStorage.getItem('codemesh_user') || 'null'),
        currentView: 'loading',
        currentSession: null,
        socket: null,
        editor: null,
        editorView: null,
        serverVersion: 0,
        pendingOps: [],
        isApplyingRemote: false,
        saveTimer: null,
        users: new Map(),
        userRole: 'editor', // 'owner' | 'editor' | 'viewer'
        comments: [],
        remoteCursors: new Map(), // track remote selections
        files: new Map(), // Map of fileId -> { id, name, doc, language, version }
        activeFileId: null,
        openTabs: new Set(), // Set of fileIds
        splitEditor: null,
        splitActive: false,
        terminal: null
    };

    // ─── API Helper ───
    const API_BASE = '/api';

    async function api(endpoint, options = {}) {
        const headers = { 'Content-Type': 'application/json' };
        if (state.token) headers['Authorization'] = `Bearer ${state.token}`;

        const res = await fetch(`${API_BASE}${endpoint}`, {
            ...options,
            headers: { ...headers, ...options.headers }
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Request failed');
        return data;
    }

    // ─── Toast Notifications ───
    function showToast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message;
        container.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('toast-out');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // ─── View Management ───
    function showView(viewName) {
        document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
        const view = document.getElementById(`${viewName}-view`);
        if (view) {
            view.style.display = '';
            view.style.animation = 'none';
            view.offsetHeight; // reflow
            view.style.animation = '';
        }
        state.currentView = viewName;
    }

    // ─── Auth Particles ───
    function initParticles() {
        const container = document.getElementById('auth-particles');
        if (!container) return;
        container.innerHTML = '';
        for (let i = 0; i < 40; i++) {
            const p = document.createElement('div');
            p.className = 'particle';
            p.style.left = Math.random() * 100 + '%';
            p.style.top = Math.random() * 100 + '%';
            p.style.animationDelay = Math.random() * 4 + 's';
            p.style.animationDuration = (3 + Math.random() * 3) + 's';
            p.style.width = p.style.height = (2 + Math.random() * 4) + 'px';
            const colors = ['#6C5CE7', '#00CEFF', '#a78bfa', '#45B7D1'];
            p.style.background = colors[Math.floor(Math.random() * colors.length)];
            container.appendChild(p);
        }
    }

    // ─── Auth Tab Switching ───
    function initAuthTabs() {
        const tabLogin = document.getElementById('tab-login');
        const tabRegister = document.getElementById('tab-register');
        const indicator = document.getElementById('tab-indicator');
        const loginForm = document.getElementById('login-form');
        const registerForm = document.getElementById('register-form');

        tabLogin.addEventListener('click', () => {
            tabLogin.classList.add('active');
            tabRegister.classList.remove('active');
            indicator.classList.remove('right');
            loginForm.style.display = '';
            registerForm.style.display = 'none';
        });

        tabRegister.addEventListener('click', () => {
            tabRegister.classList.add('active');
            tabLogin.classList.remove('active');
            indicator.classList.add('right');
            registerForm.style.display = '';
            loginForm.style.display = 'none';
        });
    }

    // ─── Auth Handlers ───
    function initAuth() {
        const loginForm = document.getElementById('login-form');
        const registerForm = document.getElementById('register-form');
        const guestBtn = document.getElementById('guest-btn');
        if (!loginForm || !registerForm || !guestBtn) return;

        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = document.getElementById('login-btn');
            const errorEl = document.getElementById('login-error');
            errorEl.textContent = '';
            btn.classList.add('loading');

            try {
                const data = await api('/auth/login', {
                    method: 'POST',
                    body: JSON.stringify({
                        email: document.getElementById('login-email').value,
                        password: document.getElementById('login-password').value
                    })
                });

                state.token = data.token;
                state.user = data.user;
                localStorage.setItem('codemesh_token', data.token);
                localStorage.setItem('codemesh_user', JSON.stringify(data.user));

                showToast('Welcome back, ' + data.user.username + '!', 'success');
                loadDashboard();
            } catch (err) {
                errorEl.textContent = err.message;
            } finally {
                btn.classList.remove('loading');
            }
        });

        registerForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = document.getElementById('register-btn');
            const errorEl = document.getElementById('register-error');
            errorEl.textContent = '';
            btn.classList.add('loading');

            try {
                const data = await api('/auth/register', {
                    method: 'POST',
                    body: JSON.stringify({
                        username: document.getElementById('register-username').value,
                        email: document.getElementById('register-email').value,
                        password: document.getElementById('register-password').value
                    })
                });

                state.token = data.token;
                state.user = data.user;
                localStorage.setItem('codemesh_token', data.token);
                localStorage.setItem('codemesh_user', JSON.stringify(data.user));

                showToast('Account created! Welcome, ' + data.user.username + '!', 'success');
                loadDashboard();
            } catch (err) {
                errorEl.textContent = err.message;
            } finally {
                btn.classList.remove('loading');
            }
        });

        guestBtn.addEventListener('click', async () => {
            const btn = guestBtn;
            btn.classList.add('loading');
            btn.disabled = true;
            try {
                const data = await api('/auth/guest', {
                    method: 'POST',
                    body: JSON.stringify({})
                });
                state.token = data.token;
                state.user = data.user;
                localStorage.setItem('codemesh_token', data.token);
                localStorage.setItem('codemesh_user', JSON.stringify(data.user));
                showToast('Welcome, ' + data.user.username + '!', 'success');
                loadDashboard();
            } catch (err) {
                showToast(err.message || 'Guest login failed', 'error');
            } finally {
                btn.classList.remove('loading');
                btn.disabled = false;
            }
        });
    }

    // ─── Logout ───
    function logout() {
        state.token = null;
        state.user = null;
        localStorage.removeItem('codemesh_token');
        localStorage.removeItem('codemesh_user');
        if (state.socket) { state.socket.disconnect(); state.socket = null; }
        showView('auth');
        initParticles();
    }

    // ─── URL session routing (e.g. /work opens session "work") ───
    function getSessionIdFromPath() {
        const path = window.location.pathname.replace(/^\/+|\/+$/g, '');
        if (!path || path === 'api' || path === 'css' || path === 'js' || path === 'socket.io') return null;
        if (/^[a-zA-Z0-9_-]{3,50}$/.test(path)) return path;
        return null;
    }

    function openSessionFromUrlIfAny() {
        const sessionId = getSessionIdFromPath();
        if (sessionId && state.token) {
            openEditor(sessionId);
        }
    }

    // ─── Dashboard ───
    async function loadDashboard() {
        showView('dashboard');
        document.getElementById('nav-username').textContent = state.user ? state.user.username : 'Guest';

        // Show admin button if user is admin
        const adminBtn = document.getElementById('admin-panel-btn');
        if (state.user && state.user.role === 'admin') {
            adminBtn.style.display = '';
        } else {
            adminBtn.style.display = 'none';
        }

        try {
            const sessions = await api('/sessions');
            renderSessions(sessions);
        } catch (err) {
            showToast('Failed to load sessions', 'error');
        }

        openSessionFromUrlIfAny();
    }

    function renderSessions(sessions) {
        const grid = document.getElementById('sessions-list');
        const empty = document.getElementById('no-sessions');

        if (!sessions.length) {
            grid.innerHTML = '';
            empty.style.display = '';
            return;
        }

        empty.style.display = 'none';
        grid.innerHTML = sessions.map(s => `
      <div class="session-card" data-session-id="${s.sessionId}">
        <div class="session-card-header">
          <div class="session-card-title">${escapeHtml(s.title)}</div>
          <span class="session-card-lang">${s.language}</span>
        </div>
        <div class="session-card-meta">
          <span class="session-card-id">ID: ${s.sessionId}</span>
          <span>•</span>
          <span>${timeAgo(s.updatedAt)}</span>
        </div>
        <div class="session-card-actions">
          <button class="btn btn-sm btn-secondary open-session-btn" data-id="${s.sessionId}">Open</button>
          <button class="btn btn-sm btn-danger delete-session-btn" data-id="${s.sessionId}" data-title="${escapeHtml(s.title)}">Delete</button>
        </div>
      </div>
    `).join('');

        // Event listeners on cards
        grid.querySelectorAll('.session-card').forEach(card => {
            card.addEventListener('click', (e) => {
                if (e.target.closest('.delete-session-btn')) return;
                openEditor(card.dataset.sessionId);
            });
        });

        grid.querySelectorAll('.delete-session-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (!confirm(`Delete session "${btn.dataset.title}"?`)) return;
                try {
                    await api(`/sessions/${btn.dataset.id}`, { method: 'DELETE' });
                    showToast('Session deleted', 'success');
                    loadDashboard();
                } catch (err) {
                    showToast(err.message, 'error');
                }
            });
        });
    }

    // ─── Dashboard Event Handlers ───
    function initDashboard() {
        document.getElementById('logout-btn').addEventListener('click', logout);

        // Create session modal
        const createBtn = document.getElementById('create-session-btn');
        const modal = document.getElementById('create-modal');
        const cancelBtn = document.getElementById('cancel-create-btn');
        const createForm = document.getElementById('create-session-form');

        createBtn.addEventListener('click', () => modal.style.display = '');
        cancelBtn.addEventListener('click', () => modal.style.display = 'none');
        modal.querySelector('.modal-backdrop').addEventListener('click', () => modal.style.display = 'none');

        createForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            try {
                const customId = document.getElementById('custom-session-id').value.trim();
                const body = {
                    title: document.getElementById('session-title').value,
                    language: document.getElementById('session-language').value
                };
                if (customId) body.customSessionId = customId;

                const session = await api('/sessions', {
                    method: 'POST',
                    body: JSON.stringify(body)
                });
                modal.style.display = 'none';
                createForm.reset();
                showToast('Session created!', 'success');
                openEditor(session.sessionId);
            } catch (err) {
                showToast(err.message, 'error');
            }
        });

        // Join session
        document.getElementById('join-session-btn').addEventListener('click', () => {
            const id = document.getElementById('join-session-id').value.trim();
            if (!id) return showToast('Enter a session ID', 'error');
            openEditor(id);
        });

        document.getElementById('join-session-id').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') document.getElementById('join-session-btn').click();
        });
    }

    // ─── CodeMirror / Monaco Setup ───
    let monacoLoaded = false;
    let monacoLoadingPromise = null;
    let remoteDecorations = null;
    let commentDecorations = null;

    async function loadMonaco() {
        if (monacoLoaded) return;
        if (monacoLoadingPromise) return monacoLoadingPromise;
        
        monacoLoadingPromise = new Promise((resolve) => {
            if (window.monaco) {
                monacoLoaded = true;
                resolve();
                return;
            }
            require.config({ paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs' }});
            require(['vs/editor/editor.main'], function() {
                monacoLoaded = true;
                resolve();
            });
        });
        return monacoLoadingPromise;
    }

    function mapLanguageToMonaco(lang) {
        const langMap = {
            javascript: 'javascript',
            typescript: 'typescript',
            python: 'python',
            html: 'html',
            css: 'css',
            java: 'java',
            cpp: 'cpp',
            csharp: 'csharp',
            php: 'php',
            rust: 'rust',
            sql: 'sql',
            markdown: 'markdown',
            go: 'go',
            ruby: 'ruby',
            plaintext: 'plaintext'
        };
        return langMap[lang] || 'javascript';
    }





    function createEditor(container, doc, language) {
        const editor = monaco.editor.create(container, {
            value: doc,
            language: mapLanguageToMonaco(language),
            theme: 'vs-dark',
            automaticLayout: true,
            glyphMargin: true,
            readOnly: state.userRole === 'viewer',
            minimap: { enabled: false },
            wordWrap: "on",
            padding: { top: 10 }
        });

        editor.onDidChangeModelContent((e) => {
            if (state.isApplyingRemote) return;
            handleLocalChange(e);
        });

        editor.onDidChangeCursorSelection((e) => {
            handleCursorUpdate(e);
        });

        editor.onMouseDown((e) => {
            if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS) {
                openCommentDialog(e.target.position.lineNumber);
            }
        });

        return editor;
    }

    function updateCommentGutter() {
        if (!state.editorView || !state.activeFileId) return;
        const decos = [];
        const linesWithComments = new Set(state.comments.filter(c => c.fileId === state.activeFileId).map(c => c.line));
        
        linesWithComments.forEach(line => {
            decos.push({
                range: new monaco.Range(line, 1, line, 1),
                options: {
                    isWholeLine: true,
                    glyphMarginClassName: 'monaco-comment-glyph'
                }
            });
        });

        if (!commentDecorations) {
            commentDecorations = state.editorView.createDecorationsCollection(decos);
        } else {
            commentDecorations.set(decos);
        }
    }

    // ─── Local Changes → Server (batched for performance) ───
    let pendingLocalOps = [];
    let localBatchTimer = null;
    const LOCAL_BATCH_MS = 30; // Buffer rapid edits for 30ms

    function handleLocalChange(e) {
        if (!state.socket || !state.currentSession) return;

        const model = state.editorView.getModel();
        if (!model) return;

        for (const change of e.changes) {
            const { rangeOffset, rangeLength, text } = change;
            if (rangeLength > 0) {
                pendingLocalOps.push({ type: 'delete', pos: rangeOffset, count: rangeLength });
            }
            if (text && text.length > 0) {
                pendingLocalOps.push({ type: 'insert', pos: rangeOffset, text });
            }
        }

        if (!localBatchTimer) {
            localBatchTimer = setTimeout(() => {
                const opsToSend = pendingLocalOps.splice(0);
                const file = state.files.get(state.activeFileId);
                const currentVersion = file ? file.version : state.serverVersion;

                opsToSend.forEach(op => {
                    state.socket.emit('code-change', {
                        sessionId: state.currentSession,
                        fileId: state.activeFileId,
                        op,
                        version: currentVersion
                    });
                });

                if (file && state.editorView) {
                    file.doc = state.editorView.getValue();
                }
                localBatchTimer = null;
            }, LOCAL_BATCH_MS);
        }

        setSaveStatus('unsaved');
        clearTimeout(state.saveTimer);
        state.saveTimer = setTimeout(() => manualSave(), 5000);
    }

    // ─── Remote Changes → Editor (batched for performance) ───
    let pendingRemoteOps = [];
    let remoteBatchTimer = null;
    const REMOTE_BATCH_MS = 16; // ~1 frame at 60fps

    function applyRemoteChange(op) {
        if (!state.editorView) return;

        pendingRemoteOps.push(op);

        if (!remoteBatchTimer) {
            remoteBatchTimer = requestAnimationFrame(() => {
                if (!state.editorView || pendingRemoteOps.length === 0) {
                    remoteBatchTimer = null;
                    return;
                }

                state.isApplyingRemote = true;
                try {
                    const model = state.editorView.getModel();
                    if (!model) return;

                    const edits = [];
                    for (const remoteOp of pendingRemoteOps) {
                        const len = model.getValueLength();
                        const pos = Math.min(remoteOp.pos, len);
                        if (remoteOp.type === 'insert') {
                            const start = model.getPositionAt(pos);
                            edits.push({
                                range: new monaco.Range(start.lineNumber, start.column, start.lineNumber, start.column),
                                text: remoteOp.text
                            });
                        } else if (remoteOp.type === 'delete') {
                            const from = model.getPositionAt(pos);
                            const toPos = Math.min(pos + remoteOp.count, len);
                            const to = model.getPositionAt(toPos);
                            edits.push({
                                range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column),
                                text: ''
                            });
                        }
                    }
                    if (edits.length > 0) {
                        state.editorView.executeEdits('remote', edits);
                    }

                    if (state.activeFileId) {
                        const file = state.files.get(state.activeFileId);
                        if (file) file.doc = state.editorView.getValue();
                    }
                } finally {
                    state.isApplyingRemote = false;
                    pendingRemoteOps = [];
                    remoteBatchTimer = null;
                }
            });
        }
    }

    // ─── Cursor Broadcasting ───
    let cursorTimer = null;
    function handleCursorUpdate(e) {
        if (!state.socket || !state.currentSession || !state.activeFileId) return;
        clearTimeout(cursorTimer);
        cursorTimer = setTimeout(() => {
            const selection = state.editorView.getSelection();
            if (!selection) return;

            const model = state.editorView.getModel();
            if (!model) return;

            const headOffset = model.getOffsetAt({ lineNumber: selection.positionLineNumber, column: selection.positionColumn });
            const fromOffset = model.getOffsetAt({ lineNumber: selection.startLineNumber, column: selection.startColumn });
            const toOffset = model.getOffsetAt({ lineNumber: selection.endLineNumber, column: selection.endColumn });

            state.socket.emit('cursor-update', {
                sessionId: state.currentSession,
                fileId: state.activeFileId,
                cursor: { line: selection.positionLineNumber, ch: selection.positionColumn },
                selection: { from: fromOffset, to: toOffset, head: headOffset }
            });

            updateStatusbarCursor(selection);
        }, 50);
    }

    function updateStatusbarCursor(selection) {
        const el = document.getElementById('statusbar-cursor');
        if (el) el.textContent = `Ln ${selection.positionLineNumber}, Col ${selection.positionColumn}`;
    }

    // ─── Save ───
    function setSaveStatus(status) {
        const el = document.getElementById('save-status');
        el.className = 'save-status ' + status;
        const text = { saved: 'Saved', saving: 'Saving...', unsaved: 'Unsaved' };
        el.innerHTML = `<span class="save-dot"></span> ${text[status] || 'Saved'}`;
    }

    async function manualSave() {
        if (!state.currentSession) return;
        setSaveStatus('saving');
        try {
            const files = Array.from(state.files.entries()).map(([id, f]) => ({
                id,
                name: f.name,
                content: f.doc,
                language: f.language
            }));
            const primaryCode = state.activeFileId && state.files.has(state.activeFileId)
                ? state.files.get(state.activeFileId).doc
                : (state.editorView ? state.editorView.getValue() : '');
            await api(`/sessions/${state.currentSession}`, {
                method: 'PUT',
                body: JSON.stringify({
                    code: primaryCode,
                    files: files.length ? files : undefined
                })
            });
            setSaveStatus('saved');
        } catch (err) {
            setSaveStatus('unsaved');
            showToast('Save failed: ' + err.message, 'error');
        }
    }

    // ─── Open Editor ───
    async function openEditor(sessionId) {
        showView('editor');

        // Show loading state in editor
        const container = document.getElementById('editor-container');
        container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);">Loading editor...</div>';

        try {
            // Load Monaco modules
            await loadMonaco();

            // Load session data (create if doesn't exist, e.g. for /work)
            let sessionData;
            try {
                sessionData = await api(`/sessions/${sessionId}`);
            } catch {
                try {
                    sessionData = await api('/sessions', {
                        method: 'POST',
                        body: JSON.stringify({
                            title: sessionId === 'work' ? 'Work' : sessionId,
                            language: 'javascript',
                            customSessionId: sessionId
                        })
                    });
                } catch (createErr) {
                    try {
                        sessionData = await api(`/sessions/${sessionId}`);
                    } catch {
                        sessionData = { sessionId, title: 'Shared Session', language: 'javascript', code: '' };
                    }
                }
            }

            state.currentSession = sessionId;
            if (state.terminal) { state.terminal.dispose(); state.terminal = null; }

            // Update URL to /sessionId for shareable links
            const path = '/' + sessionId;
            if (window.location.pathname !== path) {
                history.replaceState({ sessionId }, '', path);
            }

            // Update UI
            document.getElementById('editor-session-title').textContent = sessionData.title;
            document.getElementById('editor-session-id').textContent = `${sessionId}`;
            
            // Set language in dropdown if we have files
            if (sessionData.files && sessionData.files.length > 0) {
                document.getElementById('language-selector').value = sessionData.files[0].language || 'javascript';
            } else {
                document.getElementById('language-selector').value = sessionData.language || 'javascript';
            }
            const statusbarLangEl = document.getElementById('statusbar-lang');
            if (statusbarLangEl) {
                statusbarLangEl.textContent = document.getElementById('language-selector').options[document.getElementById('language-selector').selectedIndex].text;
            }

            // Clear and create editor
            container.innerHTML = '';
            if (state.editorView) {
                state.editorView.dispose();
            }

            // Connect WebSocket
            connectSocket(sessionId, sessionData);

        } catch (err) {
            showToast('Failed to open editor: ' + err.message, 'error');
            loadDashboard();
        }
    }

    // ─── WebSocket Connection ───
    function connectSocket(sessionId, sessionData) {
        if (state.socket) {
            state.socket.disconnect();
        }

        state.socket = io({
            transports: ['websocket'],
            reconnectionAttempts: 5,
            reconnectionDelay: 1000
        });

        state.socket.on('connect', () => {
            state.socket.emit('join-session', {
                sessionId,
                username: state.user ? state.user.username : 'Anonymous',
                userId: state.user ? state.user._id : null
            });
        });

        state.socket.on('session-state', (data) => {
            // Set user role
            state.userRole = data.role || 'editor';
            updateRoleBadge(state.userRole);

            if (data.comments) {
                state.comments = data.comments;
            }

            const container = document.getElementById('editor-container');
            container.innerHTML = '';
            
            // Load files
            state.files.clear();
            state.openTabs.clear();
            
            let firstFileId = null;
            if (data.files && Object.keys(data.files).length > 0) {
                for (const [id, fileData] of Object.entries(data.files)) {
                    state.files.set(id, {
                        id: fileData.id,
                        name: fileData.name,
                        doc: fileData.doc || '',
                        language: fileData.language || 'javascript',
                        version: fileData.version || 0
                    });
                    if (!firstFileId) firstFileId = id;
                }
            } else {
                // Fallback for empty state
                firstFileId = 'main_file';
                state.files.set(firstFileId, {
                    id: firstFileId,
                    name: 'main.js',
                    doc: '',
                    language: 'javascript',
                    version: 0
                });
            }

            // Setup initial file
            if (firstFileId) {
                openFile(firstFileId);
            }

            // Update collaborators
            if (data.users) {
                state.users.clear();
                Object.entries(data.users).forEach(([id, user]) => {
                    state.users.set(id, user);
                });
                updateCollaboratorsList();
            }

            setSaveStatus('saved');
            renderFileTree();
            renderTabs();
        });

        state.socket.on('file-created', (fileData) => {
            state.files.set(fileData.id, {
                id: fileData.id,
                name: fileData.name,
                doc: fileData.doc,
                language: fileData.language,
                version: 0
            });
            renderFileTree();
            openFile(fileData.id);
        });

        state.socket.on('file-deleted', (data) => {
            state.files.delete(data.fileId);
            state.openTabs.delete(data.fileId);
            renderFileTree();
            renderTabs();
            
            if (state.activeFileId === data.fileId) {
                if (state.openTabs.size > 0) {
                    openFile(Array.from(state.openTabs)[0]);
                } else if (state.files.size > 0) {
                    openFile(Array.from(state.files.keys())[0]);
                } else {
                    state.activeFileId = null;
                    document.getElementById('editor-container').innerHTML = '';
                    if (state.editorView) {
                        state.editorView.dispose();
                        state.editorView = null;
                    }
                }
            }
        });

        state.socket.on('file-renamed', (data) => {
            const file = state.files.get(data.fileId);
            if (file) {
                file.name = data.newName;
                renderFileTree();
                renderTabs();
            }
        });

        state.socket.on('comment-added', (comment) => {
            state.comments.push(comment);
            if (state.activeCommentLine === comment.line) {
                renderComments(comment.line);
            }
            updateCommentGutter();
            showToast('New comment on line ' + comment.line, 'info');
        });

        state.socket.on('remote-change', (data) => {
            const { fileId, op, version } = data;
            const file = state.files.get(fileId);
            if (file) {
                file.version = version;
                // If it's the active file, apply to editor
                if (fileId === state.activeFileId) {
                    applyRemoteChange(op);
                } else {
                    // Just update the doc in memory
                    // (A full OT implementation would maintain history per file here too)
                    // For simplicity right now, since it's not the active editor, 
                    // we'd need a headless way to apply the OT operation to a string, or just refetch.
                    // A proper implementation would use `CodeMirror.State.Text.replace` or similar.
                    // For now, we'll mark it as needing refresh if opened.
                    file.needsRefresh = true;
                }
            }
        });

        state.socket.on('ack', (data) => {
            const file = state.files.get(data.fileId);
            if (file) {
                file.version = data.version;
            }
        });

        state.socket.on('user-joined', (data) => {
            state.users.set(data.socketId, { username: data.username, color: data.color, role: data.role });
            updateCollaboratorsList();
            showToast(`${data.username} joined`, 'info');
        });

        state.socket.on('cursor-moved', (data) => {
            const user = state.users.get(data.socketId);
            if (user) {
                if (data.cursor) user.cursor = data.cursor;
                if (data.selection) user.selection = data.selection;
                user.activeFileId = data.fileId;
            } else {
                state.users.set(data.socketId, { username: data.username, cursor: data.cursor, selection: data.selection, color: '#6C5CE7', activeFileId: data.fileId });
            }
            // Only update selections if the remote user is on the same file
            updateRemoteSelections();
        });

        state.socket.on('user-left', (data) => {
            state.users.delete(data.socketId);
            updateCollaboratorsList();
            updateRemoteSelections();
            showToast(`${data.username} left`, 'info');
        });

        state.socket.on('language-changed', (data) => {
            const { fileId, language, userId } = data;
            const file = state.files.get(fileId);
            if (file) {
                file.language = language;
                if (fileId === state.activeFileId) {
                    document.getElementById('language-selector').value = language;
                    reconfigureLanguage(language);
                } else {
                    renderFileTree();
                    renderTabs();
                }
            }
        });

        // Role change events
        state.socket.on('role-changed', (data) => {
            state.userRole = data.role;
            updateRoleBadge(data.role);
            setEditorReadOnly(data.role === 'viewer');
            showToast(data.message, data.role === 'viewer' ? 'error' : 'success');
        });

        state.socket.on('user-role-updated', (data) => {
            const user = state.users.get(data.socketId);
            if (user) {
                user.role = data.role;
                updateCollaboratorsList();
            }
        });

        state.socket.on('readonly-error', (data) => {
            showToast(data.message, 'error');
        });

        // Handle session full error
        state.socket.on('join-error', (data) => {
            showToast(data.message, 'error');
            loadDashboard();
        });

        state.socket.on('disconnect', () => {
            showToast('Disconnected — reconnecting...', 'error');
        });

        state.socket.on('connect_error', () => {
            showToast('Connection error — retrying...', 'error');
        });
    }

    // ─── Remote Selections Render ───
    function updateRemoteSelections() {
        if (!state.editorView || !monacoLoaded || !state.activeFileId) return;

        const decos = [];
        state.users.forEach((user, id) => {
            if (!user.selection || user.activeFileId !== state.activeFileId) return;
            
            const model = state.editorView.getModel();
            if (!model) return;

            const fromPos = model.getPositionAt(user.selection.from);
            const toPos = model.getPositionAt(user.selection.to);
            const headPos = model.getPositionAt(user.selection.head);

            if (user.selection.from !== user.selection.to) {
                decos.push({
                    range: new monaco.Range(fromPos.lineNumber, fromPos.column, toPos.lineNumber, toPos.column),
                    options: { className: 'monaco-remote-selection', hoverMessage: { value: user.username } }
                });
            }

            // Cursor
            decos.push({
                range: new monaco.Range(headPos.lineNumber, headPos.column, headPos.lineNumber, headPos.column),
                options: { 
                    className: `monaco-remote-cursor monaco-remote-cursor-${id}`, 
                    hoverMessage: { value: user.username }
                }
            });
            
            // Inject dynamic style for the user's cursor color if not exists
            let styleEl = document.getElementById(`cursor-style-${id}`);
            if (!styleEl) {
                styleEl = document.createElement('style');
                styleEl.id = `cursor-style-${id}`;
                styleEl.innerHTML = `.monaco-remote-cursor-${id} { border-left: 2px solid ${user.color || '#6C5CE7'} !important; }`;
                document.head.appendChild(styleEl);
            }
        });

        if (!remoteDecorations) {
            remoteDecorations = state.editorView.createDecorationsCollection(decos);
        } else {
            remoteDecorations.set(decos);
        }
    }

    // ─── Reconfigure Language ───
    function reconfigureLanguage(lang) {
        if (!state.editorView || !monacoLoaded) return;

        monaco.editor.setModelLanguage(state.editorView.getModel(), mapLanguageToMonaco(lang));
        
        // Let server know we changed the active file's language
        if (state.socket && state.currentSession && state.activeFileId) {
            state.socket.emit('language-change', {
                sessionId: state.currentSession,
                fileId: state.activeFileId,
                language: lang
            });
            // Update local memory
            const file = state.files.get(state.activeFileId);
            if (file) {
                file.language = lang;
            }
        }
        
        updateRemoteSelections(); // Restore selections
        renderFileTree(); // Update file extension
        renderTabs();
        
        const langSelect = document.getElementById('language-selector');
        const statusbarLangEl = document.getElementById('statusbar-lang');
        if (langSelect && statusbarLangEl) {
            statusbarLangEl.textContent = langSelect.options[langSelect.selectedIndex].text;
        }
    }

    // ─── File Tree & Layout Setup ───
    function renderFileTree() {
        const fileTree = document.getElementById('file-tree');
        if (!fileTree) return;

        let html = '';
        state.files.forEach((file, id) => {
            const lang = file.language || 'javascript';
            let iconClass = 'codicon-file';
            let iconColor = '#519aba';
            if (lang === 'html') { iconClass = 'codicon-code'; iconColor = '#e34c26'; }
            else if (lang === 'css') { iconClass = 'codicon-symbol-color'; iconColor = '#563d7c'; }
            else if (lang === 'python') { iconClass = 'codicon-symbol-misc'; iconColor = '#3572A5'; }
            else if (lang === 'java') { iconClass = 'codicon-symbol-class'; iconColor = '#b07219'; }
            else if (lang === 'javascript' || lang === 'typescript') { iconClass = 'codicon-symbol-class'; iconColor = '#f1e05a'; }
            else if (lang === 'plaintext' || file.name.includes('/')) { iconClass = 'codicon-file'; iconColor = '#6e7681'; }

            const isActive = id === state.activeFileId ? 'active' : '';

            html += `
                <div class="file-item ${isActive}" data-file-id="${id}" onclick="openFile('${id}')">
                    <i class="codicon ${iconClass} file-icon" style="color: ${iconColor}; margin-right: 6px;"></i>
                    <span style="flex:1;">${file.name}</span>
                    ${state.userRole !== 'viewer' && state.files.size > 1 ? `
                    <div class="file-actions" style="opacity:0; display:flex; align-items:center;">
                        <button class="btn btn-icon btn-xs file-action-icon" style="background:none;border:none;color:inherit;cursor:pointer;padding:2px;" onclick="event.stopPropagation(); deleteFile('${id}')" title="Delete">
                            <i class="codicon codicon-trash"></i>
                        </button>
                    </div>` : ''}
                </div>
            `;
        });

        fileTree.innerHTML = html;
        
        // Add hover effect for file actions
        fileTree.querySelectorAll('.file-item').forEach(item => {
            item.addEventListener('mouseenter', () => {
                const actions = item.querySelector('.file-actions');
                if(actions) actions.style.opacity = '1';
            });
            item.addEventListener('mouseleave', () => {
                const actions = item.querySelector('.file-actions');
                if(actions) actions.style.opacity = '0';
            });
        });
    }

    function renderTabs() {
        const tabsContainer = document.getElementById('editor-tabs');
        if (!tabsContainer) return;

        let html = '';
        state.openTabs.forEach(id => {
            const file = state.files.get(id);
            if (!file) {
                state.openTabs.delete(id);
                return;
            }
            
            const lang = file.language || 'javascript';
            let iconClass = 'codicon-file';
            let iconColor = '#519aba';
            if (lang === 'html') { iconClass = 'codicon-code'; iconColor = '#e34c26'; }
            else if (lang === 'css') { iconClass = 'codicon-symbol-color'; iconColor = '#563d7c'; }
            else if (lang === 'python') { iconClass = 'codicon-symbol-misc'; iconColor = '#3572A5'; }
            else if (lang === 'java') { iconClass = 'codicon-symbol-class'; iconColor = '#b07219'; }
            else if (lang === 'javascript' || lang === 'typescript') { iconClass = 'codicon-symbol-class'; iconColor = '#f1e05a'; }

            const isActive = id === state.activeFileId ? 'active' : '';
            html += `
                <div class="editor-tab ${isActive}" data-file-id="${id}" onclick="openFile('${id}')">
                    <i class="codicon ${iconClass} tab-icon" style="color: ${iconColor}; margin-right: 6px;"></i>
                    <span class="tab-title">${file.name}</span>
                    <button class="btn btn-icon btn-xs tab-close" onclick="event.stopPropagation(); closeTab('${id}')" style="background:none;border:none;color:inherit;cursor:pointer;">
                        <i class="codicon codicon-close"></i>
                    </button>
                </div>
            `;
        });

        tabsContainer.innerHTML = html;
    }

    window.openFile = function(fileId) {
        if (!state.files.has(fileId)) return;
        
        state.activeFileId = fileId;
        state.openTabs.add(fileId);
        
        const file = state.files.get(fileId);
        
        const container = document.getElementById('editor-container');
        const container2 = document.getElementById('editor-container-2');
        const splitContainer = document.getElementById('editor-split-container');
        if (state.splitEditor) { state.splitEditor.dispose(); state.splitEditor = null; }
        if (state.editorView) state.editorView.dispose();
        
        container.innerHTML = '';
        if (container2) { container2.innerHTML = ''; container2.style.display = state.splitActive ? '' : 'none'; }
        if (splitContainer) splitContainer.classList.toggle('split-active', state.splitActive);
        state.editorView = createEditor(container, file.doc, file.language);
        if (state.splitActive && container2) {
            const model = state.editorView.getModel();
            if (model) state.splitEditor = monaco.editor.create(container2, { model, readOnly: state.userRole === 'viewer' });
        }
        
        // If viewer, make editor read-only
        if (state.userRole === 'viewer') {
            setEditorReadOnly(true);
        }

        // Update language selector
        const langSelect = document.getElementById('language-selector');
        const statusbarLangEl = document.getElementById('statusbar-lang');
        if (langSelect) {
            langSelect.value = file.language || 'javascript';
            if (statusbarLangEl) statusbarLangEl.textContent = langSelect.options[langSelect.selectedIndex].text;
        }

        renderFileTree();
        renderTabs();
        updateRemoteSelections();
    };

    window.closeTab = function(fileId) {
        state.openTabs.delete(fileId);
        
        if (state.activeFileId === fileId) {
            if (state.openTabs.size > 0) {
                openFile(Array.from(state.openTabs)[0]);
            } else {
                state.activeFileId = null;
                document.getElementById('editor-container').innerHTML = '';
                const c2 = document.getElementById('editor-container-2');
                if (c2) { c2.innerHTML = ''; c2.style.display = 'none'; }
                document.getElementById('editor-split-container')?.classList.remove('split-active');
                if (state.splitEditor) { state.splitEditor.dispose(); state.splitEditor = null; }
                if (state.editorView) { state.editorView.dispose(); state.editorView = null; }
                state.splitActive = false;
            }
        }
        
        renderTabs();
    };

    window.deleteFile = function(fileId) {
        if (state.userRole === 'viewer') return;
        if (!confirm('Are you sure you want to delete this file?')) return;
        
        state.socket.emit('delete-file', {
            sessionId: state.currentSession,
            fileId: fileId
        });
    };

    function openCommentDialog(line) {
        state.activeCommentLine = line;
        const sidebar = document.getElementById('comments-sidebar');
        document.getElementById('comments-line-num').textContent = line;
        sidebar.style.display = 'flex';
        renderComments(line);
    }

    function renderComments(line) {
        const list = document.getElementById('comments-list');
        const comments = state.comments.filter(c => c.line === line && c.fileId === state.activeFileId);
        
        if (comments.length === 0) {
            list.innerHTML = '<div style="color:#888; font-size:12px; padding:10px;">No comments on this line yet.</div>';
        } else {
            list.innerHTML = comments.map(c => `
                <div class="comment-item">
                    <div class="comment-author">${escapeHtml(c.author)}</div>
                    <div class="comment-text">${escapeHtml(c.text)}</div>
                </div>
            `).join('');
        }
        
        // scroll to bottom
        list.scrollTop = list.scrollHeight;
    }

    // ─── Update Collaborators List ───
    function updateCollaboratorsList() {
        const list = document.getElementById('collaborators-list');
        list.innerHTML = '';

        const isOwnerOrAdmin = state.userRole === 'owner' || (state.user && state.user.role === 'admin');

        state.users.forEach((user, id) => {
            const avatar = document.createElement('div');
            avatar.className = 'collab-avatar';
            avatar.style.background = user.color || '#6C5CE7';
            avatar.textContent = (user.username || '?')[0].toUpperCase();

            const roleLabel = user.role === 'owner' ? ' 👑' : user.role === 'viewer' ? ' 👁' : '';
            avatar.innerHTML += `<span class="collab-tooltip">${escapeHtml(user.username || 'User')}${roleLabel}</span>`;

            // Owner/admin can click to change roles of non-owners
            if (isOwnerOrAdmin && user.role !== 'owner') {
                avatar.style.cursor = 'pointer';
                avatar.addEventListener('click', (e) => {
                    e.stopPropagation();
                    // Remove any existing dropdowns
                    document.querySelectorAll('.role-dropdown').forEach(d => d.remove());

                    const dropdown = document.createElement('div');
                    dropdown.className = 'role-dropdown';
                    dropdown.innerHTML = `
                        <button data-role="editor" class="${user.role === 'editor' ? 'active-role' : ''}">🟢 Editor</button>
                        <button data-role="viewer" class="${user.role === 'viewer' ? 'active-role' : ''}">👁 Viewer</button>
                    `;
                    dropdown.querySelectorAll('button').forEach(btn => {
                        btn.addEventListener('click', (ev) => {
                            ev.stopPropagation();
                            const newRole = btn.dataset.role;
                            state.socket.emit('set-user-role', {
                                sessionId: state.currentSession,
                                targetSocketId: id,
                                role: newRole
                            });
                            dropdown.remove();
                        });
                    });
                    avatar.appendChild(dropdown);

                    // Close on outside click
                    setTimeout(() => {
                        document.addEventListener('click', function handler() {
                            dropdown.remove();
                            document.removeEventListener('click', handler);
                        });
                    }, 10);
                });
            }

            list.appendChild(avatar);
        });
    }

    // ─── Role Badge ───
    function updateRoleBadge(role) {
        const badge = document.getElementById('user-role-badge');
        if (!badge) return;
        badge.style.display = '';
        badge.className = `role-badge role-${role}`;
        const labels = { owner: '👑 Owner', editor: '🟢 Editor', viewer: '👁 Viewer' };
        badge.textContent = labels[role] || role;
    }

    function toggleSidebar() {
        const sidebar = document.querySelector('.vscode-sidebar');
        if (sidebar) sidebar.style.display = sidebar.style.display === 'none' ? '' : 'none';
    }

    function togglePanel() {
        const up = document.getElementById('unified-panel');
        if (!up) return;
        up.style.display = up.style.display === 'none' ? '' : 'none';
    }

    // ─── Set Editor Read-Only ───
    function setEditorReadOnly(readonly) {
        if (!state.editorView) return;

        state.editorView.updateOptions({ readOnly: readonly });

        // Add/remove viewer overlay
        const container = document.getElementById('editor-container');
        const existing = container.querySelector('.viewer-overlay');
        if (readonly && !existing) {
            const overlay = document.createElement('div');
            overlay.className = 'viewer-overlay';
            overlay.textContent = '\ud83d\udc41 View Only';
            container.style.position = 'relative';
            container.appendChild(overlay);
        } else if (!readonly && existing) {
            existing.remove();
        }
    }

    // ─── Integrated Terminal ───
    function initTerminal() {
        const container = document.getElementById('terminal-container');
        if (!container || state.terminal) return;
        if (typeof Terminal === 'undefined') {
            container.innerHTML = '<div class="problems-placeholder">Terminal requires xterm.js. Refresh the page.</div>';
            return;
        }
        container.innerHTML = '';
        const term = new Terminal({ cursorBlink: true, theme: { background: '#1e1e1e', foreground: '#d4d4d4' } });
        term.open(container);
        term.writeln('CodeMesh Terminal (type a command and press Enter)');
        term.writeln('Allowed: node, python3, python, npm, npx, ls, pwd, echo, cat, clear, whoami, date');
        term.write('\r\n$ ');
        let currentLine = '';
        term.onData((data) => {
            if (data === '\r' || data === '\n') {
                const cmd = currentLine.trim();
                currentLine = '';
                if (cmd === 'clear') {
                    term.clear();
                    term.write('$ ');
                    return;
                }
                if (!cmd) { term.write('\r\n$ '); return; }
                term.writeln('');
                api('/terminal/exec', { method: 'POST', body: JSON.stringify({ command: cmd }) })
                    .then(r => {
                        if (r.output) term.writeln(r.output);
                        if (r.error) term.writeln('\x1b[31m' + r.error + '\x1b[0m');
                    })
                    .catch(err => term.writeln('\x1b[31mError: ' + err.message + '\x1b[0m'))
                    .finally(() => term.write('\r\n$ '));
            } else if (data === '\u007F') {
                if (currentLine.length) {
                    currentLine = currentLine.slice(0, -1);
                    term.write('\b \b');
                }
            } else {
                currentLine += data;
                term.write(data);
            }
        });
        state.terminal = term;
    }

    // ─── Editor Toolbar Events ───
    function initEditorToolbar() {
        const backBtn = document.getElementById('back-to-dashboard');
        backBtn?.addEventListener('click', () => {
            if (state.socket) { state.socket.disconnect(); state.socket = null; }
            if (state.splitEditor) { state.splitEditor.dispose(); state.splitEditor = null; }
            if (state.editorView) { state.editorView.dispose(); state.editorView = null; }
            if (state.terminal) { state.terminal.dispose(); state.terminal = null; }
            state.splitActive = false;
            state.currentSession = null;
            state.users.clear();
            const up = document.getElementById('unified-panel');
            if (up) up.style.display = 'none';
            history.replaceState({}, '', '/');
            loadDashboard();
        });

        document.getElementById('language-selector')?.addEventListener('change', (e) => {
            const lang = e.target.value;
            reconfigureLanguage(lang);
        });

        document.getElementById('copy-session-link')?.addEventListener('click', () => {
            const id = state.currentSession;
            if (id) {
                const url = window.location.origin + '/' + id;
                navigator.clipboard.writeText(url).then(() => {
                    showToast('Session link copied to clipboard!', 'success');
                }).catch(() => {
                    // Fallback
                    const input = document.createElement('input');
                    input.value = url;
                    document.body.appendChild(input);
                    input.select();
                    document.execCommand('copy');
                    input.remove();
                    showToast('Session link copied!', 'success');
                });
            }
        });

        document.getElementById('editor-session-id')?.addEventListener('click', () => {
            document.getElementById('copy-session-link').click();
        });

        document.getElementById('statusbar-save')?.addEventListener('click', () => {
            manualSave();
        });

        // ─── Run Code ───
        document.getElementById('run-code-btn')?.addEventListener('click', runCode);

        document.getElementById('clear-output-btn')?.addEventListener('click', () => {
            document.getElementById('output-content').innerHTML = '';
            document.getElementById('exec-time').textContent = '';
        });

        document.getElementById('close-panel-btn')?.addEventListener('click', () => {
            const up = document.getElementById('unified-panel');
            if (up) up.style.display = 'none';
        });

        document.getElementById('open-preview-new-tab')?.addEventListener('click', () => {
            const iframe = document.getElementById('preview-iframe');
            if (iframe && iframe.srcdoc) {
                const w = window.open('', '_blank');
                w.document.write(iframe.srcdoc);
                w.document.close();
            }
        });

        // Ctrl+Enter to run code, Ctrl+S to save
        document.addEventListener('keydown', (e) => {
            if (state.currentView !== 'editor') return;
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                runCode();
            } else if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                manualSave();
            }
        });

        // ─── Menubar (dropdown actions) ───
        document.querySelectorAll('.menubar-dropdown-item[data-action]').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = item.dataset.action;
                if (action === 'new-file') document.getElementById('create-file-action')?.click();
                else if (action === 'save') manualSave();
                else if (action === 'undo' && state.editorView) state.editorView.trigger('keyboard', 'undo', null);
                else if (action === 'redo' && state.editorView) state.editorView.trigger('keyboard', 'redo', null);
                else if (action === 'find' && state.editorView) { state.editorView.focus(); state.editorView.trigger('toggleFind', 'actions.find'); }
                else if (action === 'select-all' && state.editorView) state.editorView.trigger('keyboard', 'editor.action.selectAll', null);
                else if (action === 'toggle-sidebar') toggleSidebar();
                else if (action === 'toggle-panel') togglePanel();
                else if (action === 'go-to-line' && state.editorView) state.editorView.trigger('', 'editor.action.gotoLine', null);
                else if (action === 'run-code') runCode();
                else if (action === 'about') showToast('CodeMesh — Real-time Collaborative Code Editor', 'info');
            });
        });

        // ─── Activity Bar ───
        document.querySelectorAll('.activity-action[data-activity]').forEach(el => {
            el.addEventListener('click', () => {
                document.querySelectorAll('.activity-action').forEach(a => a.classList.remove('active'));
                el.classList.add('active');
                const act = el.dataset.activity;
                const sidebar = document.querySelector('.vscode-sidebar');
                if (act === 'explorer') {
                    if (sidebar) sidebar.style.display = '';
                    const tree = document.getElementById('file-tree');
                    const extPanel = document.getElementById('extensions-panel');
                    if (tree) tree.style.display = '';
                    if (extPanel) extPanel.style.display = 'none';
                }
                else if (act === 'search') { state.editorView?.focus(); state.editorView?.trigger('toggleFind', 'actions.find'); }
                else if (act === 'source-control') {
                    if (sidebar) sidebar.style.display = '';
                    const tree = document.getElementById('file-tree');
                    const extPanel = document.getElementById('extensions-panel');
                    if (tree) tree.style.display = '';
                    if (extPanel) extPanel.style.display = 'none';
                    showToast('Source control: CodeMesh syncs automatically.', 'info');
                }
                else if (act === 'run') runCode();
                else if (act === 'extensions') {
                    if (sidebar) sidebar.style.display = '';
                    const tree = document.getElementById('file-tree');
                    const extPanel = document.getElementById('extensions-panel');
                    if (tree) tree.style.display = 'none';
                    if (extPanel) extPanel.style.display = 'block';
                }
            });
        });

        // ─── Sidebar Actions (4 buttons: New File, New Folder, Refresh, Collapse) ───
        document.getElementById('create-file-action')?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (state.userRole === 'viewer') return;
            if (!state.socket || !state.currentSession) {
                showToast('Open a session first.', 'info');
                return;
            }
            const name = prompt('Enter file name (e.g., style.css):');
            if (!name) return;
            let lang = 'javascript';
            if (name.endsWith('.html')) lang = 'html';
            else if (name.endsWith('.css')) lang = 'css';
            else if (name.endsWith('.py')) lang = 'python';
            else if (name.endsWith('.js')) lang = 'javascript';
            else if (name.endsWith('.ts')) lang = 'typescript';
            state.socket.emit('create-file', { sessionId: state.currentSession, name, language: lang });
        });
        document.getElementById('new-folder-action')?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (state.userRole === 'viewer') return;
            if (!state.socket || !state.currentSession) {
                showToast('Open a session first.', 'info');
                return;
            }
            const name = prompt('Enter folder name (e.g., src):');
            if (!name) return;
            state.socket.emit('create-file', { sessionId: state.currentSession, name: name + '/.gitkeep', language: 'plaintext' });
            showToast('Folder created. Add files via New File.', 'success');
        });
        document.getElementById('refresh-explorer-action')?.addEventListener('click', () => {
            if (state.socket && state.currentSession) {
                state.socket.emit('request-state', { sessionId: state.currentSession });
                showToast('Refreshing...', 'info');
            } else {
                showToast('Open a session first.', 'info');
            }
        });
        document.getElementById('collapse-explorer-action')?.addEventListener('click', () => {
            const tree = document.getElementById('file-tree');
            const section = document.querySelector('.sidebar-section');
            if (tree && section) {
                const isCollapsed = tree.style.display === 'none';
                tree.style.display = isCollapsed ? '' : 'none';
                const chevron = section.querySelector('.sidebar-section-header .codicon');
                if (chevron) chevron.className = isCollapsed ? 'codicon codicon-chevron-down' : 'codicon codicon-chevron-right';
            }
        });

        // ─── Split Editor ───
        document.getElementById('split-editor-btn')?.addEventListener('click', () => {
            if (!state.editorView) return;
            const container2 = document.getElementById('editor-container-2');
            const splitContainer = document.getElementById('editor-split-container');
            if (state.splitActive && state.splitEditor) {
                state.splitEditor.dispose();
                state.splitEditor = null;
                state.splitActive = false;
                if (container2) container2.style.display = 'none';
                if (splitContainer) splitContainer.classList.remove('split-active');
            } else {
                const model = state.editorView.getModel();
                if (!model) return;
                if (container2) container2.style.display = '';
                if (splitContainer) splitContainer.classList.add('split-active');
                state.splitEditor = monaco.editor.create(container2, { model, readOnly: state.userRole === 'viewer' });
                state.splitActive = true;
            }
        });

        // ─── Panel Tab Switching ───
        document.querySelectorAll('#panel-tabs .vscode-panel-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const tabId = tab.dataset.panelTab;
                document.querySelectorAll('#panel-tabs .vscode-panel-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                ['output', 'preview', 'problems', 'terminal'].forEach(id => {
                    const el = document.getElementById(id + '-panel-content');
                    if (el) el.style.display = id === tabId ? '' : 'none';
                });
                if (tabId === 'terminal') initTerminal();
            });
        });

        // ─── Comment Events ───
        document.getElementById('close-comments-btn').addEventListener('click', () => {
            document.getElementById('comments-sidebar').style.display = 'none';
            state.activeCommentLine = null;
        });

        document.getElementById('submit-comment-btn').addEventListener('click', () => {
            const input = document.getElementById('new-comment-input');
            const text = input.value.trim();
            if (text && state.activeCommentLine !== null && state.socket && state.activeFileId) {
                state.socket.emit('add-comment', {
                    sessionId: state.currentSession,
                    fileId: state.activeFileId,
                    line: state.activeCommentLine,
                    text
                });
                input.value = '';
            }
        });

        document.getElementById('new-comment-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                document.getElementById('submit-comment-btn').click();
            }
        });
    }

    // ─── Code Execution ───
    async function runCode() {
        if (!state.editorView) return;

        const code = state.editorView.getValue();
        const language = document.getElementById('language-selector').value;

        if (!code.trim()) {
            showToast('Nothing to run — editor is empty', 'error');
            return;
        }

        const runBtn = document.getElementById('run-code-btn');
        const unifiedPanel = document.getElementById('unified-panel');
        const outputPanelContent = document.getElementById('output-panel-content');
        const previewContent = document.getElementById('preview-panel-content');

        // HTML: show live preview in panel
        if (language === 'html') {
            if (unifiedPanel) unifiedPanel.style.display = '';
            if (outputPanelContent) outputPanelContent.style.display = 'none';
            if (previewContent) previewContent.style.display = '';
            document.querySelectorAll('#panel-tabs .vscode-panel-tab').forEach(t => t.classList.remove('active'));
            const previewTab = document.querySelector('#panel-tabs .vscode-panel-tab[data-panel-tab="preview"]');
            if (previewTab) previewTab.classList.add('active');
            const iframe = document.getElementById('preview-iframe');
            if (iframe) iframe.srcdoc = code;
            showToast('HTML preview updated', 'success');
            return;
        }

        // Languages that support execution
        const runnableLanguages = ['javascript', 'python', 'typescript', 'cpp', 'java', 'csharp', 'go', 'rust', 'php', 'ruby'];
        if (!runnableLanguages.includes(language)) {
            showToast(`${language} cannot be executed. Supported: JS, Python, TS, C++, Java, Go, Rust, PHP, Ruby. Use HTML for preview.`, 'error');
            return;
        }

        const outputContent = document.getElementById('output-content');
        const execTimeEl = document.getElementById('exec-time');

        // Show unified panel with output tab
        if (unifiedPanel) unifiedPanel.style.display = '';
        if (outputPanelContent) outputPanelContent.style.display = '';
        if (previewContent) previewContent.style.display = 'none';
        document.querySelectorAll('#panel-tabs .vscode-panel-tab').forEach(t => t.classList.remove('active'));
        const outputTab = document.querySelector('#panel-tabs .vscode-panel-tab[data-panel-tab="output"]');
        if (outputTab) outputTab.classList.add('active');
        runBtn.classList.add('running');
        const runBtnSpan = runBtn.querySelector('span');
        if (runBtnSpan) runBtnSpan.textContent = 'Running...';
        if (outputContent) outputContent.innerHTML = '<span class="output-info">⏳ Executing code...</span>';
        execTimeEl.textContent = '';

        try {
            const result = await api('/run', {
                method: 'POST',
                body: JSON.stringify({ code, language })
            });

            let html = '';

            if (result.output) {
                html += `<span class="output-success">${escapeHtml(result.output)}</span>`;
            }
            if (result.error) {
                if (html) html += '\n';
                html += `<span class="output-error">${escapeHtml(result.error)}</span>`;
            }

            if (result.timedOut) {
                html += '\n<span class="output-error">⚠ Execution timed out (10s limit)</span>';
            }

            if (!result.output && !result.error) {
                html = '<span class="output-info">Program finished with no output</span>';
            }

            // Show exit code if non-zero
            if (result.exitCode && result.exitCode !== 0 && !result.timedOut) {
                html += `\n<span class="output-info">Exit code: ${result.exitCode}</span>`;
            }

            outputContent.innerHTML = html;
            execTimeEl.textContent = result.execTime ? `${result.execTime}ms` : '';

        } catch (err) {
            outputContent.innerHTML = `<span class="output-error">Error: ${escapeHtml(err.message)}</span>`;
            execTimeEl.textContent = '';
        } finally {
            runBtn.classList.remove('running');
            const runBtnSpan = runBtn.querySelector('span');
            if (runBtnSpan) runBtnSpan.textContent = 'Run';
        }
    }

    // ─── Utilities ───
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function timeAgo(dateStr) {
        const now = Date.now();
        const then = new Date(dateStr).getTime();
        const diff = Math.floor((now - then) / 1000);

        if (diff < 60) return 'just now';
        if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
        if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
        return new Date(dateStr).toLocaleDateString();
    }

    // ═══════════ ADMIN PANEL ═══════════
    function initAdminPanel() {
        // Admin button in dashboard nav
        document.getElementById('admin-panel-btn').addEventListener('click', () => {
            loadAdminPanel();
        });

        // Back button
        document.getElementById('admin-back-btn').addEventListener('click', () => {
            loadDashboard();
        });

        // Admin tabs
        document.querySelectorAll('.admin-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');

                const target = tab.dataset.adminTab;
                document.getElementById('admin-users-panel').style.display = target === 'users' ? '' : 'none';
                document.getElementById('admin-sessions-panel').style.display = target === 'sessions' ? '' : 'none';
            });
        });
    }

    async function loadAdminPanel() {
        showView('admin');
        await Promise.all([loadAdminUsers(), loadAdminSessions()]);
    }

    async function loadAdminUsers() {
        try {
            const users = await api('/admin/users');
            document.getElementById('admin-user-count').textContent = `${users.length} users`;

            const tbody = document.getElementById('admin-users-tbody');
            tbody.innerHTML = users.map(u => `
                <tr data-user-id="${u._id}">
                    <td><strong>${escapeHtml(u.username)}</strong></td>
                    <td>${escapeHtml(u.email)}</td>
                    <td><span class="badge ${u.role === 'admin' ? 'badge-admin' : 'badge-user'}">${u.role}</span></td>
                    <td>${u.sessionCount || 0}</td>
                    <td><span class="badge ${u.banned ? 'badge-banned' : 'badge-active'}">${u.banned ? 'Banned' : 'Active'}</span></td>
                    <td>${new Date(u.createdAt).toLocaleDateString()}</td>
                    <td>
                        <div class="admin-actions">
                            ${u.role !== 'admin' ? `
                                ${u.banned
                        ? `<button class="btn-unban" onclick="window._adminUnban('${u._id}')">Unban</button>`
                        : `<button class="btn-ban" onclick="window._adminBan('${u._id}')">Ban</button>`
                    }
                                <button class="btn-delete" onclick="window._adminDeleteUser('${u._id}', '${escapeHtml(u.username)}')">Delete</button>
                            ` : '<span style="color:var(--text-muted);font-size:0.75rem">Protected</span>'}
                        </div>
                    </td>
                </tr>
            `).join('');
        } catch (err) {
            showToast('Failed to load users: ' + err.message, 'error');
        }
    }

    async function loadAdminSessions() {
        try {
            const sessions = await api('/admin/sessions');
            document.getElementById('admin-session-count').textContent = `${sessions.length} sessions`;

            const tbody = document.getElementById('admin-sessions-tbody');
            tbody.innerHTML = sessions.map(s => `
                <tr>
                    <td><code>${escapeHtml(s.sessionId)}</code></td>
                    <td>${escapeHtml(s.title)}</td>
                    <td>${s.owner ? escapeHtml(s.owner.username) : 'Unknown'}</td>
                    <td><span class="badge badge-user">${s.language}</span></td>
                    <td>${timeAgo(s.updatedAt)}</td>
                    <td>
                        <div class="admin-actions">
                            <button class="btn-delete" onclick="window._adminDeleteSession('${s.sessionId}', '${escapeHtml(s.title)}')">Delete</button>
                        </div>
                    </td>
                </tr>
            `).join('');
        } catch (err) {
            showToast('Failed to load sessions: ' + err.message, 'error');
        }
    }

    // Expose admin actions to window for inline onclick handlers
    window._adminBan = async function (userId) {
        if (!confirm('Ban this user?')) return;
        try {
            const result = await api(`/admin/users/${userId}/ban`, { method: 'PUT' });
            showToast(result.message, 'success');
            loadAdminUsers();
        } catch (err) {
            showToast(err.message, 'error');
        }
    };

    window._adminUnban = async function (userId) {
        try {
            const result = await api(`/admin/users/${userId}/unban`, { method: 'PUT' });
            showToast(result.message, 'success');
            loadAdminUsers();
        } catch (err) {
            showToast(err.message, 'error');
        }
    };

    window._adminDeleteUser = async function (userId, username) {
        if (!confirm(`Delete user "${username}" and all their sessions? This cannot be undone.`)) return;
        try {
            const result = await api(`/admin/users/${userId}`, { method: 'DELETE' });
            showToast(result.message, 'success');
            loadAdminUsers();
            loadAdminSessions();
        } catch (err) {
            showToast(err.message, 'error');
        }
    };

    window._adminDeleteSession = async function (sessionId, title) {
        if (!confirm(`Delete session "${title}"?`)) return;
        try {
            const result = await api(`/admin/sessions/${sessionId}`, { method: 'DELETE' });
            showToast(result.message, 'success');
            loadAdminSessions();
        } catch (err) {
            showToast(err.message, 'error');
        }
    };

    // ─── App Initialization ───
    function init() {
        initAuthTabs();
        initAuth();
        initDashboard();
        initEditorToolbar();
        initAdminPanel();

        // Remove loading overlay
        setTimeout(() => {
            const overlay = document.getElementById('loading-overlay');
            overlay.classList.add('hidden');

            if (state.token && state.user) {
                loadDashboard();
            } else {
                showView('auth');
                initParticles();
            }
        }, 800);
    }

    // Start app when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
