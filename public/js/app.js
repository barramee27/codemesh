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
        userRole: 'editor' // 'owner' | 'editor' | 'viewer'
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

    // ─── Dashboard ───
    async function loadDashboard() {
        showView('dashboard');
        document.getElementById('nav-username').textContent = state.user.username;

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

    // ─── CodeMirror Editor ───
    let cmModulesLoaded = false;
    let cmModules = {};

    async function loadCodeMirror() {
        if (cmModulesLoaded) return;

        // Load CodeMirror ESM modules from CDN
        const [
            { EditorState },
            { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars,
                drawSelection, dropCursor, rectangularSelection, crosshairCursor,
                highlightActiveLine },
            { defaultHighlightStyle, syntaxHighlighting, indentOnInput, bracketMatching,
                foldGutter, foldKeymap, LanguageDescription },
            { defaultKeymap, history, historyKeymap, indentWithTab },
            { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap },
            { searchKeymap, highlightSelectionMatches },
            { javascript },
            { python },
            { html },
            { css },
            { java },
            { cpp },
            { php },
            { rust },
            { sql },
            { markdown },
            { oneDark }
        ] = await Promise.all([
            import('https://esm.sh/@codemirror/state@6'),
            import('https://esm.sh/@codemirror/view@6'),
            import('https://esm.sh/@codemirror/language@6'),
            import('https://esm.sh/@codemirror/commands@6'),
            import('https://esm.sh/@codemirror/autocomplete@6'),
            import('https://esm.sh/@codemirror/search@6'),
            import('https://esm.sh/@codemirror/lang-javascript@6'),
            import('https://esm.sh/@codemirror/lang-python@6'),
            import('https://esm.sh/@codemirror/lang-html@6'),
            import('https://esm.sh/@codemirror/lang-css@6'),
            import('https://esm.sh/@codemirror/lang-java@6'),
            import('https://esm.sh/@codemirror/lang-cpp@6'),
            import('https://esm.sh/@codemirror/lang-php@6'),
            import('https://esm.sh/@codemirror/lang-rust@6'),
            import('https://esm.sh/@codemirror/lang-sql@6'),
            import('https://esm.sh/@codemirror/lang-markdown@6'),
            import('https://esm.sh/@codemirror/theme-one-dark@6')
        ]);

        cmModules = {
            EditorState, EditorView, keymap, lineNumbers, highlightActiveLineGutter,
            highlightSpecialChars, drawSelection, dropCursor, rectangularSelection,
            crosshairCursor, highlightActiveLine, defaultHighlightStyle,
            syntaxHighlighting, indentOnInput, bracketMatching, foldGutter, foldKeymap,
            defaultKeymap, history, historyKeymap, indentWithTab,
            closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap,
            searchKeymap, highlightSelectionMatches, oneDark,
            languages: { javascript, python, html, css, java, cpp, php, rust, sql, markdown }
        };

        cmModulesLoaded = true;
    }

    function getLanguageExtension(lang) {
        const langMap = {
            javascript: () => cmModules.languages.javascript({ jsx: true }),
            typescript: () => cmModules.languages.javascript({ typescript: true, jsx: true }),
            python: () => cmModules.languages.python(),
            html: () => cmModules.languages.html(),
            css: () => cmModules.languages.css(),
            java: () => cmModules.languages.java(),
            cpp: () => cmModules.languages.cpp(),
            csharp: () => cmModules.languages.java(), // close enough syntax
            php: () => cmModules.languages.php(),
            rust: () => cmModules.languages.rust(),
            sql: () => cmModules.languages.sql(),
            markdown: () => cmModules.languages.markdown(),
            go: () => cmModules.languages.javascript(), // fallback
            ruby: () => cmModules.languages.python() // fallback
        };
        return (langMap[lang] || langMap.javascript)();
    }

    function createEditor(container, doc, language) {
        const {
            EditorState, EditorView, keymap, lineNumbers, highlightActiveLineGutter,
            highlightSpecialChars, drawSelection, dropCursor, rectangularSelection,
            crosshairCursor, highlightActiveLine, defaultHighlightStyle,
            syntaxHighlighting, indentOnInput, bracketMatching, foldGutter, foldKeymap,
            defaultKeymap, history, historyKeymap, indentWithTab,
            closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap,
            searchKeymap, highlightSelectionMatches, oneDark
        } = cmModules;

        const updateListener = EditorView.updateListener.of((update) => {
            if (update.docChanged && !state.isApplyingRemote) {
                handleLocalChange(update);
            }
            if (update.selectionSet) {
                handleCursorUpdate(update);
            }
        });

        const editorState = EditorState.create({
            doc,
            extensions: [
                lineNumbers(),
                highlightActiveLineGutter(),
                highlightSpecialChars(),
                history(),
                foldGutter(),
                drawSelection(),
                dropCursor(),
                EditorState.allowMultipleSelections.of(true),
                indentOnInput(),
                syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
                bracketMatching(),
                closeBrackets(),
                autocompletion(),
                rectangularSelection(),
                crosshairCursor(),
                highlightActiveLine(),
                highlightSelectionMatches(),
                keymap.of([
                    ...closeBracketsKeymap,
                    ...defaultKeymap,
                    ...searchKeymap,
                    ...historyKeymap,
                    ...foldKeymap,
                    ...completionKeymap,
                    indentWithTab
                ]),
                getLanguageExtension(language),
                oneDark,
                updateListener,
                EditorView.theme({
                    '&': { height: '100%' },
                    '.cm-scroller': { overflow: 'auto' }
                })
            ]
        });

        const view = new EditorView({
            state: editorState,
            parent: container
        });

        return view;
    }

    // ─── Local Changes → Server (batched for performance) ───
    let pendingLocalOps = [];
    let localBatchTimer = null;
    const LOCAL_BATCH_MS = 30; // Buffer rapid edits for 30ms

    function handleLocalChange(update) {
        if (!state.socket || !state.currentSession) return;

        update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
            // Delete operation
            if (toA > fromA) {
                pendingLocalOps.push({
                    type: 'delete',
                    pos: fromA,
                    count: toA - fromA
                });
            }

            // Insert operation
            const insertedText = inserted.toString();
            if (insertedText.length > 0) {
                pendingLocalOps.push({
                    type: 'insert',
                    pos: fromA,
                    text: insertedText
                });
            }
        });

        // Batch ops and send after a short delay
        if (!localBatchTimer) {
            localBatchTimer = setTimeout(() => {
                const opsToSend = pendingLocalOps.splice(0);
                opsToSend.forEach(op => {
                    state.socket.emit('code-change', {
                        sessionId: state.currentSession,
                        op,
                        version: state.serverVersion
                    });
                });
                localBatchTimer = null;
            }, LOCAL_BATCH_MS);
        }

        // Update save status
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

        // Batch multiple remote ops into a single editor transaction
        if (!remoteBatchTimer) {
            remoteBatchTimer = requestAnimationFrame(() => {
                if (!state.editorView || pendingRemoteOps.length === 0) {
                    remoteBatchTimer = null;
                    return;
                }

                state.isApplyingRemote = true;
                try {
                    const changes = [];
                    for (const remoteOp of pendingRemoteOps) {
                        const doc = state.editorView.state.doc;
                        if (remoteOp.type === 'insert') {
                            const pos = Math.min(remoteOp.pos, doc.length);
                            changes.push({ from: pos, insert: remoteOp.text });
                        } else if (remoteOp.type === 'delete') {
                            const from = Math.min(remoteOp.pos, doc.length);
                            const to = Math.min(remoteOp.pos + remoteOp.count, doc.length);
                            changes.push({ from, to });
                        }
                    }
                    if (changes.length > 0) {
                        // Apply all changes in one transaction
                        state.editorView.dispatch({ changes: changes[0] });
                        // Apply remaining one by one (positions shift after each)
                        for (let i = 1; i < changes.length; i++) {
                            state.editorView.dispatch({ changes: changes[i] });
                        }
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
    function handleCursorUpdate(update) {
        if (!state.socket || !state.currentSession) return;
        clearTimeout(cursorTimer);
        cursorTimer = setTimeout(() => {
            const pos = update.state.selection.main.head;
            const line = update.state.doc.lineAt(pos);
            state.socket.emit('cursor-update', {
                sessionId: state.currentSession,
                cursor: { line: line.number, ch: pos - line.from }
            });
        }, 50);
    }

    // ─── Save ───
    function setSaveStatus(status) {
        const el = document.getElementById('save-status');
        el.className = 'save-status ' + status;
        const text = { saved: 'Saved', saving: 'Saving...', unsaved: 'Unsaved' };
        el.innerHTML = `<span class="save-dot"></span> ${text[status] || 'Saved'}`;
    }

    async function manualSave() {
        if (!state.currentSession || !state.editorView) return;
        setSaveStatus('saving');
        try {
            await api(`/sessions/${state.currentSession}`, {
                method: 'PUT',
                body: JSON.stringify({
                    code: state.editorView.state.doc.toString()
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
            // Load CodeMirror modules
            await loadCodeMirror();

            // Load session data
            let sessionData;
            try {
                sessionData = await api(`/sessions/${sessionId}`);
            } catch {
                // Session doesn't exist, might be joining
                sessionData = { sessionId, title: 'Shared Session', language: 'javascript', code: '' };
            }

            state.currentSession = sessionId;

            // Update UI
            document.getElementById('editor-session-title').textContent = sessionData.title;
            document.getElementById('editor-session-id').textContent = `ID: ${sessionId}`;
            document.getElementById('language-selector').value = sessionData.language || 'javascript';

            // Clear and create editor
            container.innerHTML = '';
            if (state.editorView) {
                state.editorView.destroy();
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
            state.serverVersion = data.version;

            // Set user role
            state.userRole = data.role || 'editor';
            updateRoleBadge(state.userRole);

            const container = document.getElementById('editor-container');
            container.innerHTML = '';

            state.editorView = createEditor(container, data.doc || '', data.language || 'javascript');

            // If viewer, make editor read-only
            if (state.userRole === 'viewer') {
                setEditorReadOnly(true);
            }

            // Update language selector
            document.getElementById('language-selector').value = data.language || 'javascript';

            // Update collaborators
            if (data.users) {
                state.users.clear();
                Object.entries(data.users).forEach(([id, user]) => {
                    state.users.set(id, user);
                });
                updateCollaboratorsList();
            }

            setSaveStatus('saved');
        });

        state.socket.on('remote-change', (data) => {
            state.serverVersion = data.version;
            applyRemoteChange(data.op);
        });

        state.socket.on('ack', (data) => {
            state.serverVersion = data.version;
        });

        state.socket.on('user-joined', (data) => {
            state.users.set(data.socketId, { username: data.username, color: data.color, role: data.role });
            updateCollaboratorsList();
            showToast(`${data.username} joined`, 'info');
        });

        state.socket.on('user-left', (data) => {
            state.users.delete(data.socketId);
            updateCollaboratorsList();
            showToast(`${data.username} left`, 'info');
        });

        state.socket.on('cursor-moved', (data) => {
            // Remote cursor updates could be visualized here
        });

        state.socket.on('language-changed', (data) => {
            document.getElementById('language-selector').value = data.language;
            reconfigureLanguage(data.language);
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

    // ─── Reconfigure Language ───
    function reconfigureLanguage(lang) {
        if (!state.editorView || !cmModulesLoaded) return;

        const doc = state.editorView.state.doc.toString();
        const container = document.getElementById('editor-container');
        container.innerHTML = '';

        state.editorView.destroy();
        state.editorView = createEditor(container, doc, lang);
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

    // ─── Set Editor Read-Only ───
    function setEditorReadOnly(readonly) {
        if (!state.editorView) return;

        // Toggle contenteditable on the CM content DOM
        const cmContent = state.editorView.contentDOM;
        if (cmContent) {
            cmContent.contentEditable = readonly ? 'false' : 'true';
        }

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

    // ─── Editor Toolbar Events ───
    function initEditorToolbar() {
        document.getElementById('back-to-dashboard').addEventListener('click', () => {
            if (state.socket) { state.socket.disconnect(); state.socket = null; }
            if (state.editorView) { state.editorView.destroy(); state.editorView = null; }
            state.currentSession = null;
            state.users.clear();
            // Hide output panel when leaving editor
            document.getElementById('output-panel').style.display = 'none';
            loadDashboard();
        });

        document.getElementById('language-selector').addEventListener('change', (e) => {
            const lang = e.target.value;
            reconfigureLanguage(lang);
            if (state.socket && state.currentSession) {
                state.socket.emit('language-change', {
                    sessionId: state.currentSession,
                    language: lang
                });
            }
        });

        document.getElementById('copy-session-link').addEventListener('click', () => {
            const id = state.currentSession;
            if (id) {
                navigator.clipboard.writeText(id).then(() => {
                    showToast('Session ID copied to clipboard!', 'success');
                }).catch(() => {
                    // Fallback
                    const input = document.createElement('input');
                    input.value = id;
                    document.body.appendChild(input);
                    input.select();
                    document.execCommand('copy');
                    input.remove();
                    showToast('Session ID copied!', 'success');
                });
            }
        });

        document.getElementById('editor-session-id').addEventListener('click', () => {
            document.getElementById('copy-session-link').click();
        });

        document.getElementById('save-session-btn').addEventListener('click', () => {
            manualSave();
        });

        // ─── Run Code ───
        document.getElementById('run-code-btn').addEventListener('click', runCode);

        document.getElementById('clear-output-btn').addEventListener('click', () => {
            document.getElementById('output-content').innerHTML = '';
            document.getElementById('exec-time').textContent = '';
        });

        document.getElementById('close-output-btn').addEventListener('click', () => {
            document.getElementById('output-panel').style.display = 'none';
        });

        // Ctrl+Enter to run code
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && state.currentView === 'editor') {
                e.preventDefault();
                runCode();
            }
        });
    }

    // ─── Code Execution ───
    async function runCode() {
        if (!state.editorView) return;

        const code = state.editorView.state.doc.toString();
        const language = document.getElementById('language-selector').value;

        if (!code.trim()) {
            showToast('Nothing to run — editor is empty', 'error');
            return;
        }

        // Languages that support execution
        const runnableLanguages = ['javascript', 'python', 'typescript', 'cpp', 'java', 'csharp', 'go', 'rust', 'php', 'ruby'];
        if (!runnableLanguages.includes(language)) {
            showToast(`${language} cannot be executed. Supported: JS, Python, TS, C++, Java, Go, Rust, PHP, Ruby`, 'error');
            return;
        }

        const runBtn = document.getElementById('run-code-btn');
        const outputPanel = document.getElementById('output-panel');
        const outputContent = document.getElementById('output-content');
        const execTimeEl = document.getElementById('exec-time');

        // Show panel + loading
        outputPanel.style.display = '';
        runBtn.classList.add('running');
        runBtn.querySelector('span').textContent = 'Running...';
        outputContent.innerHTML = '<span class="output-info">⏳ Executing code...</span>';
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
            runBtn.querySelector('span').textContent = 'Run';
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
