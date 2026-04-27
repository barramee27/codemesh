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
        chatMessages: [],
        remoteCursors: new Map(), // track remote selections
        files: new Map(), // Map of fileId -> { id, name, doc, language, version }
        activeFileId: null,
        openTabs: new Set(), // Set of fileIds
        splitEditor: null,
        splitActive: false,
        terminal: null,
        /** Folder paths (e.g. `routes`) collapsed in explorer; absent = expanded */
        fileTreeCollapsed: new Set()
    };

    let xtermCtorCached = null;

    // ─── API Helper ───
    const API_BASE = '/api';

    async function api(endpoint, options = {}) {
        const headers = {};
        if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
        if (!(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';

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

                sessionStorage.removeItem('codemesh_explicit_logout');
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

                sessionStorage.removeItem('codemesh_explicit_logout');
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
                sessionStorage.removeItem('codemesh_explicit_logout');
                showToast('Welcome, ' + data.user.username + '!', 'success');
                loadDashboard();
            } catch (err) {
                showToast(err.message || 'Guest login failed', 'error');
            } finally {
                btn.classList.remove('loading');
                btn.disabled = false;
            }
        });

        // Forgot password
        const forgotLink = document.getElementById('forgot-password-link');
        const forgotForm = document.getElementById('forgot-password-form');
        const backToLogin = document.getElementById('back-to-login');
        if (forgotLink && forgotForm && backToLogin) {
            forgotLink.addEventListener('click', () => {
                loginForm.style.display = 'none';
                registerForm.style.display = 'none';
                forgotForm.style.display = '';
                document.getElementById('forgot-error').textContent = '';
                document.getElementById('forgot-success').style.display = 'none';
            });
            backToLogin.addEventListener('click', () => {
                forgotForm.style.display = 'none';
                loginForm.style.display = '';
            });
            forgotForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const btn = document.getElementById('forgot-btn');
                const errorEl = document.getElementById('forgot-error');
                const successEl = document.getElementById('forgot-success');
                errorEl.textContent = '';
                successEl.style.display = 'none';
                btn.classList.add('loading');
                try {
                    await api('/auth/forgot-password', {
                        method: 'POST',
                        body: JSON.stringify({ email: document.getElementById('forgot-email').value })
                    });
                    successEl.textContent = 'If an account exists, a reset link has been sent to your email.';
                    successEl.style.display = '';
                } catch (err) {
                    errorEl.textContent = err.message;
                } finally {
                    btn.classList.remove('loading');
                }
            });
        }
    }

    function initResetPassword() {
        const resetForm = document.getElementById('reset-password-form');
        if (!resetForm) return;

        resetForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const token = new URLSearchParams(window.location.search).get('token');
            if (!token) {
                document.getElementById('reset-error').textContent = 'Invalid or missing reset link';
                return;
            }
            const newPass = document.getElementById('reset-new-password').value;
            const confirmPass = document.getElementById('reset-confirm-password').value;
            const errorEl = document.getElementById('reset-error');
            const btn = document.getElementById('reset-btn');
            errorEl.textContent = '';
            if (newPass !== confirmPass) {
                errorEl.textContent = 'Passwords do not match';
                return;
            }
            btn.classList.add('loading');
            try {
                await api('/auth/reset-password', {
                    method: 'POST',
                    body: JSON.stringify({ token, newPassword: newPass })
                });
                showToast('Password reset successfully. You can now sign in.', 'success');
                window.location.href = '/';
            } catch (err) {
                errorEl.textContent = err.message;
            } finally {
                btn.classList.remove('loading');
            }
        });
    }

    function initParticlesIn(container) {
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

    // ─── Logout ───
    function logout() {
        state.token = null;
        state.user = null;
        localStorage.removeItem('codemesh_token');
        localStorage.removeItem('codemesh_user');
        sessionStorage.setItem('codemesh_explicit_logout', '1');
        if (state.socket) { state.socket.disconnect(); state.socket = null; }
        showView('auth');
        initParticles();
    }

    // ─── URL routing: /ROOM editor, /ROOM/web | /ROOM/site read-only HTML preview ═══
    const RESERVED_PATH_SEGMENTS = new Set([
        'api', 'css', 'js', 'uploads', 'socket.io', 'reset-password', 'admin', 'login', 'register',
        'web', 'site', 'clash'
    ]);
    const PUBLISH_SUFFIXES = new Set(['web', 'site']);

    let publishBlobUrl = null;
    let currentClashSlug = null;
    let clashPollInterval = null;
    let clashTickInterval = null;
    let clashLobbyTickInterval = null;
    let clashMonacoEditor = null;

    function isClashCodemeshHost() {
        return window.location.hostname.replace(/^www\./i, '') === 'clash.codemesh.org';
    }

    function isAdminCodemeshHost() {
        return window.location.hostname.replace(/^www\./i, '') === 'admin.codemesh.org';
    }

    function clashHubPath() {
        return isClashCodemeshHost() ? '/' : '/clash';
    }

    function clashRoomUrlPath(slug) {
        return isClashCodemeshHost() ? `/c/${encodeURIComponent(slug)}` : `/clash/${encodeURIComponent(slug)}`;
    }

    function parseAppPath() {
        const host = window.location.hostname.replace(/^www\./i, '');
        if (host === 'admin.codemesh.org') {
            return { mode: 'admin-host' };
        }
        if (host === 'clash.codemesh.org') {
            const rawH = window.location.pathname.replace(/^\/+|\/+$/g, '');
            const partsH = rawH.split('/').filter(Boolean);
            if (partsH.length === 0) return { mode: 'clash-hub' };
            if (partsH.length >= 2 && partsH[0].toLowerCase() === 'c') {
                return { mode: 'clash-room', clashSlug: partsH[1] };
            }
            return { mode: 'clash-room', clashSlug: partsH[0] };
        }

        const raw = window.location.pathname.replace(/^\/+|\/+$/g, '');
        if (!raw) return null;
        const parts = raw.split('/').filter(Boolean);
        const first = parts[0];

        if (first && first.toLowerCase() === 'clash') {
            if (parts.length === 1) return { mode: 'clash-hub' };
            if (parts.length >= 2 && /^[a-zA-Z0-9_-]{4,40}$/.test(parts[1])) {
                return { mode: 'clash-room', clashSlug: parts[1] };
            }
            return { mode: 'clash-hub' };
        }

        if (!first || RESERVED_PATH_SEGMENTS.has(first.toLowerCase())) return null;

        if (parts.length === 1) {
            if (/^[a-zA-Z0-9_-]{3,50}$/.test(first)) return { sessionId: first, mode: 'editor' };
            return null;
        }
        if (parts.length === 2) {
            const sid = first;
            const sub = parts[1].toLowerCase();
            if (!/^[a-zA-Z0-9_-]{3,50}$/.test(sid)) return null;
            if (PUBLISH_SUFFIXES.has(sub)) return { sessionId: sid, mode: 'publish', publishPath: sub };
            return null;
        }
        return null;
    }

    function pickHtmlForPublish(sessionData) {
        const files = sessionData.files || [];
        if (!files.length) return null;
        const norm = (n) => String(n || '').toLowerCase().replace(/\\/g, '/');
        const indexNames = new Set(['index.html', 'index.htm', 'index.xhtml', 'default.html', 'default.htm']);
        let hit = files.find((f) => {
            const n = norm(f.name);
            const base = n.includes('/') ? n.slice(n.lastIndexOf('/') + 1) : n;
            return indexNames.has(base) || n.endsWith('/index.html') || n.endsWith('/index.htm');
        });
        if (!hit) {
            hit = files.find((f) => {
                const n = norm(f.name);
                return n.endsWith('.html') || n.endsWith('.htm') || n.endsWith('.xhtml');
            });
        }
        return hit || null;
    }

    function revokePublishBlob() {
        if (publishBlobUrl) {
            URL.revokeObjectURL(publishBlobUrl);
            publishBlobUrl = null;
        }
    }

    const DEFAULT_DOC_TITLE = 'CodeMesh — Real-time Collaborative Code Editor';

    function setDocumentTitle(t) {
        document.title = t || DEFAULT_DOC_TITLE;
    }

    async function openPublish(sessionId, publishPath) {
        const seg = publishPath && PUBLISH_SUFFIXES.has(publishPath) ? publishPath : 'web';
        showView('publish');
        const wrap = document.getElementById('publish-frame-wrap');
        const empty = document.getElementById('publish-empty');
        const iframe = document.getElementById('publish-frame');
        const label = document.getElementById('publish-session-label');
        const pv = document.getElementById('publish-view');
        revokePublishBlob();
        if (pv) pv.dataset.sessionId = sessionId;
        if (label) label.textContent = sessionId;
        setDocumentTitle(`Preview · ${sessionId} · CodeMesh`);
        if (wrap) wrap.style.display = 'none';
        if (empty) empty.style.display = 'none';
        if (iframe) {
            iframe.removeAttribute('src');
        }

        try {
            const sessionData = await api('/sessions/join-or-create', {
                method: 'POST',
                body: JSON.stringify({ sessionId, title: sessionId })
            });
            const file = pickHtmlForPublish(sessionData);
            if (!file || !String(file.content || '').trim()) {
                if (wrap) wrap.style.display = 'none';
                if (empty) empty.style.display = '';
                const canon = '/' + sessionId + '/' + seg;
                if (window.location.pathname !== canon) {
                    history.replaceState({ sessionId, publish: true }, '', canon);
                }
                return;
            }
            const blob = new Blob([file.content], { type: 'text/html;charset=utf-8' });
            publishBlobUrl = URL.createObjectURL(blob);
            if (iframe) iframe.src = publishBlobUrl;
            if (wrap) wrap.style.display = '';
            if (empty) empty.style.display = 'none';
            const canon = '/' + sessionId + '/' + seg;
            if (window.location.pathname !== canon) {
                history.replaceState({ sessionId, publish: true }, '', canon);
            }
        } catch (err) {
            setDocumentTitle(DEFAULT_DOC_TITLE);
            showToast(err.message || 'Could not load preview', 'error');
            history.replaceState({}, '', '/');
            loadDashboard();
        }
    }

    function initPublishViewControls() {
        const pv = document.getElementById('publish-view');
        if (!pv || pv.dataset.bound === '1') return;
        pv.dataset.bound = '1';
        window.addEventListener('pagehide', revokePublishBlob);
        document.getElementById('publish-open-editor')?.addEventListener('click', () => {
            const sid = document.getElementById('publish-view')?.dataset.sessionId;
            if (sid) window.location.href = '/' + sid;
        });
        document.getElementById('publish-empty-open-editor')?.addEventListener('click', () => {
            const sid = document.getElementById('publish-view')?.dataset.sessionId;
            if (sid) window.location.href = '/' + sid;
        });
        document.getElementById('publish-copy-url')?.addEventListener('click', () => {
            const sid = document.getElementById('publish-view')?.dataset.sessionId;
            if (!sid) return;
            const sub = window.location.pathname.split('/').filter(Boolean)[1] || 'web';
            const url = `${window.location.origin}/${sid}/${PUBLISH_SUFFIXES.has(sub.toLowerCase()) ? sub.toLowerCase() : 'web'}`;
            navigator.clipboard.writeText(url).then(() => showToast('Page link copied', 'success')).catch(() => {
                const input = document.createElement('input');
                input.value = url;
                document.body.appendChild(input);
                input.select();
                document.execCommand('copy');
                input.remove();
                showToast('Page link copied', 'success');
            });
        });
    }

    async function importGitHubIntoCurrentSession() {
        if (!state.currentSession) {
            showToast('Open a session first', 'error');
            return;
        }
        const raw = window.prompt('Public GitHub repo as owner/name (e.g. octocat/Hello-World):', '');
        if (!raw || !raw.trim()) return;
        const repo = raw.trim().replace(/^\/+|\/+$/g, '');
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
            showToast('Use exactly owner/repo (letters, numbers, . _ -)', 'error');
            return;
        }
        const branchRaw = window.prompt('Branch (leave empty for repo default):', '');
        try {
            const result = await api(`/sessions/${state.currentSession}/import-github`, {
                method: 'POST',
                body: JSON.stringify({
                    repo,
                    branch: branchRaw && branchRaw.trim() ? branchRaw.trim() : undefined
                })
            });
            showToast(result.message + ' — open the session again from the dashboard to load new files.', 'success');
        } catch (err) {
            showToast(err.message || 'Import failed', 'error');
        }
    }

    async function ensureGuestIfNeeded() {
        // Stale JWT in localStorage skips guest and breaks every API + WebSocket — revalidate first.
        if (state.token) {
            try {
                const res = await fetch(`${API_BASE}/sessions`, {
                    headers: { Authorization: `Bearer ${state.token}` }
                });
                if (res.status !== 401) return;
            } catch (e) {
                return;
            }
            state.token = null;
            state.user = null;
            localStorage.removeItem('codemesh_token');
            localStorage.removeItem('codemesh_user');
        }

        const data = await api('/auth/guest', {
            method: 'POST',
            body: JSON.stringify({})
        });
        state.token = data.token;
        state.user = data.user;
        localStorage.setItem('codemesh_token', data.token);
        localStorage.setItem('codemesh_user', JSON.stringify(data.user));
    }

    // ─── Dashboard ───
    async function loadDashboard() {
        setDocumentTitle(DEFAULT_DOC_TITLE);
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
        document.getElementById('logout-btn')?.addEventListener('click', logout);

        // Create session modal
        const createBtn = document.getElementById('create-session-btn');
        const modal = document.getElementById('create-modal');
        const cancelBtn = document.getElementById('cancel-create-btn');
        const createForm = document.getElementById('create-session-form');

        createBtn?.addEventListener('click', () => { if (modal) modal.style.display = ''; });
        cancelBtn?.addEventListener('click', () => { if (modal) modal.style.display = 'none'; });
        modal?.querySelector('.modal-backdrop')?.addEventListener('click', () => { modal.style.display = 'none'; });

        createForm?.addEventListener('submit', async (e) => {
            e.preventDefault();
            try {
                const customId = document.getElementById('custom-session-id')?.value?.trim();
                const titleVal = document.getElementById('session-title')?.value?.trim();
                const body = {
                    title: titleVal || undefined
                };
                if (customId) body.customSessionId = customId;

                const session = await api('/sessions', {
                    method: 'POST',
                    body: JSON.stringify(body)
                });
                if (modal) modal.style.display = 'none';
                if (createForm) createForm.reset();
                showToast('Session created!', 'success');
                openEditor(session.sessionId);
            } catch (err) {
                showToast(err.message, 'error');
            }
        });

        // Join session
        document.getElementById('join-session-btn')?.addEventListener('click', () => {
            const id = document.getElementById('join-session-id')?.value?.trim();
            if (!id) return showToast('Enter a session ID', 'error');
            openEditor(id);
        });

        document.getElementById('join-session-id')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') document.getElementById('join-session-btn')?.click();
        });
    }

    // ─── CodeMirror / Monaco Setup ───
    let monacoLoaded = false;
    let monacoLoadingPromise = null;
    let remoteDecorations = null;
    let commentDecorations = null;

    async function loadMonaco() {
        if (monacoLoaded) return;
        if (!monacoLoadingPromise) {
            monacoLoadingPromise = new Promise((resolve, reject) => {
                if (window.monaco && window.monaco.editor) {
                    monacoLoaded = true;
                    resolve();
                    return;
                }
                function startMain() {
                    require.config({ paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs' } });
                    require(['vs/editor/editor.main'], function () {
                        monacoLoaded = true;
                        resolve();
                    }, (e) => reject(e || new Error('Monaco failed to load')));
                }
                if (typeof require !== 'undefined' && typeof require.config === 'function') {
                    startMain();
                    return;
                }
                const script = document.createElement('script');
                script.src = 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs/loader.min.js';
                script.onload = startMain;
                script.onerror = () => reject(new Error('Failed to load Monaco loader'));
                document.head.appendChild(script);
            }).finally(() => {
                monacoLoadingPromise = null;
            });
        }
        await monacoLoadingPromise;
        if (!monacoLoaded) {
            throw new Error('Monaco editor failed to initialize');
        }
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
            c: 'c',
            csharp: 'csharp',
            php: 'php',
            rust: 'rust',
            sql: 'sql',
            markdown: 'markdown',
            go: 'go',
            ruby: 'ruby',
            json: 'json',
            yaml: 'yaml',
            xml: 'xml',
            shell: 'shell',
            scss: 'scss',
            less: 'less',
            plaintext: 'plaintext'
        };
        return langMap[lang] || 'javascript';
    }

    /** VS Code–style: language from file name / extension */
    function inferLanguageFromFileName(name) {
        const lower = (name || '').toLowerCase();
        const dot = lower.lastIndexOf('.');
        const ext = dot >= 0 ? lower.slice(dot) : '';
        const byExt = {
            '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
            '.ts': 'typescript', '.tsx': 'typescript',
            '.py': 'python', '.pyw': 'python',
            '.html': 'html', '.htm': 'html',
            '.css': 'css', '.scss': 'scss', '.less': 'less',
            '.java': 'java',
            '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp',
            '.c': 'c', '.h': 'c',
            '.cs': 'csharp',
            '.go': 'go',
            '.rs': 'rust',
            '.php': 'php',
            '.rb': 'ruby',
            '.sql': 'sql',
            '.md': 'markdown', '.markdown': 'markdown',
            '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
            '.xml': 'xml',
            '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
            '.gitkeep': 'plaintext'
        };
        return byExt[ext] || 'plaintext';
    }

    function languageDisplayName(lang) {
        const m = {
            javascript: 'JavaScript', typescript: 'TypeScript', python: 'Python', html: 'HTML', css: 'CSS',
            java: 'Java', cpp: 'C++', c: 'C', csharp: 'C#', go: 'Go', rust: 'Rust', php: 'PHP', ruby: 'Ruby',
            sql: 'SQL', markdown: 'Markdown', json: 'JSON', yaml: 'YAML', xml: 'XML', shell: 'Shell',
            scss: 'SCSS', less: 'LESS', plaintext: 'Plain Text'
        };
        return m[lang] || (lang ? lang.charAt(0).toUpperCase() + lang.slice(1) : 'Plain Text');
    }

    function updateStatusbarLanguage(lang) {
        const el = document.getElementById('statusbar-lang');
        if (el) el.textContent = languageDisplayName(lang || 'plaintext');
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

            // Load or create session (shareable URL; requires guest/auth token)
            const sessionData = await api('/sessions/join-or-create', {
                method: 'POST',
                body: JSON.stringify({ sessionId, title: sessionId })
            });

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
            setDocumentTitle(`${sessionData.title || sessionId} · CodeMesh`);

            const firstLang = (sessionData.files && sessionData.files.length > 0)
                ? (sessionData.files[0].language || inferLanguageFromFileName(sessionData.files[0].name))
                : (sessionData.language || 'javascript');
            updateStatusbarLanguage(firstLang);

            // Clear and create editor
            container.innerHTML = '';
            if (state.editorView) {
                state.editorView.dispose();
            }

            // Connect WebSocket
            connectSocket(sessionId, sessionData);

        } catch (err) {
            setDocumentTitle(DEFAULT_DOC_TITLE);
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
            reconnectionDelay: 1000,
            auth: { token: state.token || '' }
        });

        state.socket.on('connect', () => {
            state.socket.emit('join-session', {
                sessionId,
                username: state.user ? state.user.username : 'Anonymous',
                userId: state.user ? (state.user.id || state.user._id) : null
            });
        });

        state.socket.on('session-state', (data) => {
            // Set user role
            state.userRole = data.role || 'editor';
            updateRoleBadge(state.userRole);

            if (data.comments) {
                state.comments = data.comments;
            }
            if (Array.isArray(data.chatMessages)) {
                state.chatMessages = data.chatMessages;
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
            renderChatMessages();
        });

        state.socket.on('chat-message', (msg) => {
            state.chatMessages = state.chatMessages || [];
            state.chatMessages.push(msg);
            if (state.chatMessages.length > 200) state.chatMessages = state.chatMessages.slice(-100);
            renderChatMessages();
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
            const { fileId, language } = data;
            const file = state.files.get(fileId);
            if (file) {
                file.language = language;
                if (fileId === state.activeFileId) {
                    updateStatusbarLanguage(language);
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
        updateStatusbarLanguage(lang);
    }

    // ─── File Tree (nested folders from path names, e.g. routes/auth.js) ───
    function fileIconForLang(lang, isFolder) {
        if (isFolder) return { iconClass: 'codicon-folder', iconColor: '#dcb67a' };
        let iconClass = 'codicon-file';
        let iconColor = '#519aba';
        if (lang === 'html') { iconClass = 'codicon-code'; iconColor = '#e34c26'; }
        else if (lang === 'css') { iconClass = 'codicon-symbol-color'; iconColor = '#563d7c'; }
        else if (lang === 'python') { iconClass = 'codicon-symbol-misc'; iconColor = '#3572A5'; }
        else if (lang === 'java') { iconClass = 'codicon-symbol-class'; iconColor = '#b07219'; }
        else if (lang === 'javascript' || lang === 'typescript') { iconClass = 'codicon-symbol-class'; iconColor = '#f1e05a'; }
        else if (lang === 'plaintext') { iconClass = 'codicon-file'; iconColor = '#6e7681'; }
        return { iconClass, iconColor };
    }

    function buildFileTrie(filesMap) {
        const root = { kind: 'root', children: Object.create(null) };
        filesMap.forEach((file, id) => {
            const parts = String(file.name || '').replace(/\\/g, '/').split('/').filter(Boolean);
            if (!parts.length) return;
            let node = root;
            for (let i = 0; i < parts.length; i++) {
                const seg = parts[i];
                const isLast = i === parts.length - 1;
                if (!node.children) node.children = Object.create(null);
                if (isLast) {
                    node.children[seg] = { kind: 'file', id, file, seg };
                } else {
                    const ex = node.children[seg];
                    if (ex && ex.kind === 'file') {
                        const joined = parts.slice(i).join('/');
                        node.children[joined] = { kind: 'file', id, file, seg: joined };
                        return;
                    }
                    if (!ex || ex.kind !== 'dir') {
                        node.children[seg] = { kind: 'dir', seg, children: Object.create(null) };
                    }
                    node = node.children[seg];
                }
            }
        });
        return root;
    }

    function sortTrieEntries(entries) {
        return entries.sort(([a, na], [b, nb]) => {
            const da = na.kind === 'dir' ? 0 : 1;
            const db = nb.kind === 'dir' ? 0 : 1;
            if (da !== db) return da - db;
            return a.localeCompare(b, undefined, { sensitivity: 'base' });
        });
    }

    function renderTrieHtml(node, depth, pathPrefix) {
        if (!node.children) return '';
        const entries = sortTrieEntries(Object.entries(node.children));
        let html = '';
        for (const [name, child] of entries) {
            const pad = 6 + depth * 14;
            if (child.kind === 'file') {
                const { id, file } = child;
                const lang = file.language || inferLanguageFromFileName(file.name);
                const { iconClass, iconColor } = fileIconForLang(lang, false);
                const isActive = id === state.activeFileId ? 'active' : '';
                html += `
                <div class="file-item ${isActive}" data-file-id="${id}" style="padding-left:${pad}px">
                    <i class="codicon ${iconClass} file-icon" style="color: ${iconColor}; margin-right: 6px;"></i>
                    <span style="flex:1;" title="${escapeHtml(file.name)}">${escapeHtml(name)}</span>
                    ${state.userRole !== 'viewer' && state.files.size > 1 ? `
                    <div class="file-actions" style="opacity:0; display:flex; align-items:center;">
                        <button type="button" class="btn btn-icon btn-xs file-action-icon" style="background:none;border:none;color:inherit;cursor:pointer;padding:2px;" data-delete-file="${id}" title="Delete">
                            <i class="codicon codicon-trash"></i>
                        </button>
                    </div>` : ''}
                </div>`;
            } else {
                const folderKey = pathPrefix ? `${pathPrefix}/${name}` : name;
                const collapsed = state.fileTreeCollapsed.has(folderKey);
                const chev = collapsed ? 'codicon-chevron-right' : 'codicon-chevron-down';
                html += `
                <div class="file-tree-folder" style="padding-left:${pad}px">
                    <div class="file-tree-folder-row" data-tree-toggle="${encodeURIComponent(folderKey)}">
                        <i class="codicon ${chev} file-tree-chevron"></i>
                        <i class="codicon codicon-folder file-icon" style="color:#dcb67a;margin-right:6px;"></i>
                        <span class="file-tree-folder-name" title="${escapeHtml(folderKey)}">${escapeHtml(name)}</span>
                    </div>
                    ${collapsed ? '' : `<div class="file-tree-folder-children">${renderTrieHtml(child, depth + 1, folderKey)}</div>`}
                </div>`;
            }
        }
        return html;
    }

    function onFileTreeClick(e) {
        const toggle = e.target.closest('[data-tree-toggle]');
        if (toggle) {
            e.preventDefault();
            const raw = toggle.getAttribute('data-tree-toggle');
            const key = raw ? decodeURIComponent(raw) : '';
            if (!key) return;
            if (state.fileTreeCollapsed.has(key)) state.fileTreeCollapsed.delete(key);
            else state.fileTreeCollapsed.add(key);
            renderFileTree();
            return;
        }
        const delBtn = e.target.closest('[data-delete-file]');
        if (delBtn) {
            e.stopPropagation();
            const fid = delBtn.getAttribute('data-delete-file');
            if (fid) window.deleteFile(fid);
            return;
        }
        const row = e.target.closest('.file-item[data-file-id]');
        if (row && row.dataset.fileId) {
            window.openFile(row.dataset.fileId);
        }
    }

    function bindFileTreeDelegationOnce() {
        const fileTree = document.getElementById('file-tree');
        if (!fileTree || fileTree.dataset.clickBound === '1') return;
        fileTree.dataset.clickBound = '1';
        fileTree.addEventListener('click', onFileTreeClick);
        fileTree.addEventListener('mouseover', (e) => {
            const item = e.target.closest('.file-item');
            if (!item || !fileTree.contains(item)) return;
            const act = item.querySelector('.file-actions');
            if (act) act.style.opacity = '1';
        });
        fileTree.addEventListener('mouseout', (e) => {
            const item = e.target.closest('.file-item');
            if (!item) return;
            const rel = e.relatedTarget;
            if (rel && item.contains(rel)) return;
            const act = item.querySelector('.file-actions');
            if (act) act.style.opacity = '0';
        });
    }

    function renderFileTree() {
        const fileTree = document.getElementById('file-tree');
        if (!fileTree) return;
        bindFileTreeDelegationOnce();

        const trie = buildFileTrie(state.files);
        fileTree.innerHTML = renderTrieHtml(trie, 0, '');
    }

    function fileBasename(path) {
        const n = String(path || '').replace(/\\/g, '/');
        const i = n.lastIndexOf('/');
        return i >= 0 ? n.slice(i + 1) : n;
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
            
            const lang = file.language || inferLanguageFromFileName(file.name);
            let iconClass = 'codicon-file';
            let iconColor = '#519aba';
            if (lang === 'html') { iconClass = 'codicon-code'; iconColor = '#e34c26'; }
            else if (lang === 'css') { iconClass = 'codicon-symbol-color'; iconColor = '#563d7c'; }
            else if (lang === 'python') { iconClass = 'codicon-symbol-misc'; iconColor = '#3572A5'; }
            else if (lang === 'java') { iconClass = 'codicon-symbol-class'; iconColor = '#b07219'; }
            else if (lang === 'javascript' || lang === 'typescript') { iconClass = 'codicon-symbol-class'; iconColor = '#f1e05a'; }

            const isActive = id === state.activeFileId ? 'active' : '';
            const tabLabel = fileBasename(file.name);
            html += `
                <div class="editor-tab ${isActive}" data-file-id="${id}" onclick="openFile('${id}')">
                    <i class="codicon ${iconClass} tab-icon" style="color: ${iconColor}; margin-right: 6px;"></i>
                    <span class="tab-title" title="${escapeHtml(file.name)}">${escapeHtml(tabLabel)}</span>
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
        state.editorView = createEditor(container, file.doc, file.language || inferLanguageFromFileName(file.name));
        if (state.splitActive && container2) {
            const model = state.editorView.getModel();
            if (model) state.splitEditor = monaco.editor.create(container2, { model, readOnly: state.userRole === 'viewer' });
        }
        
        // If viewer, make editor read-only
        if (state.userRole === 'viewer') {
            setEditorReadOnly(true);
        }

        if (!file.language) file.language = inferLanguageFromFileName(file.name);
        updateStatusbarLanguage(file.language);

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

    function renderChatMessages() {
        const el = document.getElementById('chat-messages');
        if (!el) return;
        el.innerHTML = '';
        (state.chatMessages || []).forEach(msg => {
            const div = document.createElement('div');
            div.className = 'chat-message';
            div.innerHTML = `<div class="chat-username">${escapeHtml(msg.username || 'Anonymous')}</div><div class="chat-text">${escapeHtml(msg.text)}</div>`;
            el.appendChild(div);
        });
        el.scrollTop = el.scrollHeight;
    }

    function sendChatMessage() {
        const input = document.getElementById('chat-input');
        if (!input || !state.socket || !state.currentSession) return;
        const text = input.value.trim();
        if (!text) return;
        state.socket.emit('chat-message', { sessionId: state.currentSession, text });
        input.value = '';
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

    // ─── Integrated Terminal (ESM xterm — script-tag UMD breaks after Monaco’s AMD define) ───
    async function ensureXtermCss() {
        if (document.querySelector('link[data-codemesh-xterm-css]')) return;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css';
        link.dataset.codemeshXtermCss = '1';
        document.head.appendChild(link);
    }

    async function loadXtermConstructor() {
        if (xtermCtorCached) return xtermCtorCached;
        const urls = [
            'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/+esm',
            'https://esm.sh/@xterm/xterm@5.5.0'
        ];
        let lastErr;
        for (const u of urls) {
            try {
                const mod = await import(u);
                const T = mod.Terminal || mod.default;
                if (typeof T === 'function') {
                    xtermCtorCached = T;
                    return T;
                }
            } catch (e) {
                lastErr = e;
            }
        }
        throw lastErr || new Error('Could not load xterm module');
    }

    async function initTerminal() {
        const container = document.getElementById('terminal-container');
        if (!container || state.terminal) return;

        try {
            const status = await api('/terminal/status');
            if (!status.enabled) {
                container.innerHTML = '<div class="problems-placeholder">' +
                    '<i class="codicon codicon-terminal" style="font-size: 48px; opacity: 0.3; margin-bottom: 12px;"></i>' +
                    '<p>Terminal Disabled</p>' +
                    '<p style="font-size: 12px; color: var(--vscode-descriptionForeground);">' +
                    'The host has turned the terminal off (DISABLE_TERMINAL).</p>' +
                    '</div>';
                return;
            }
        } catch (err) {
            container.innerHTML = '<div class="problems-placeholder">Could not reach terminal API: ' +
                escapeHtml(err.message || 'unknown error') + '</div>';
            return;
        }

        container.innerHTML = '<div class="problems-placeholder">Loading terminal…</div>';

        try {
            await ensureXtermCss();
            const Terminal = await loadXtermConstructor();
            container.innerHTML = '';
            const term = new Terminal({ cursorBlink: true, theme: { background: '#1e1e1e', foreground: '#d4d4d4' } });
            term.open(container);
            term.writeln('CodeMesh Terminal (type a command and press Enter)');
            term.writeln('Allowed: node, python3, python, ls, pwd, echo, clear, whoami, date');
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
        } catch (err) {
            container.innerHTML = '<div class="problems-placeholder">Terminal load failed: ' +
                escapeHtml(err.message || String(err)) + '</div>';
        }
    }

    function sessionUsesNextJs() {
        for (const f of state.files.values()) {
            const n = (f.name || '').replace(/\\/g, '/').toLowerCase();
            if (!n.endsWith('package.json')) continue;
            try {
                const j = JSON.parse(f.doc || '{}');
                if (j.dependencies?.next || j.devDependencies?.next) return true;
            } catch (_) { /* ignore */ }
        }
        return false;
    }

    function openHtmlPreviewInNewTab() {
        const iframe = document.getElementById('preview-iframe');
        const fromIframe = (iframe && iframe.srcdoc) ? String(iframe.srcdoc).trim() : '';
        const nextHint = () => {
            if (sessionUsesNextJs()) {
                showToast('Next.js: CodeMesh only serves static HTML here. Use npm run dev on your machine for full SSR/hot reload.', 'info');
            }
        };

        if (fromIframe) {
            const u = URL.createObjectURL(new Blob([fromIframe], { type: 'text/html;charset=utf-8' }));
            const w = window.open(u, '_blank', 'noopener,noreferrer');
            if (!w) {
                URL.revokeObjectURL(u);
                showToast('Pop-up blocked — allow pop-ups for this site to open the preview.', 'error');
                return;
            }
            setTimeout(() => URL.revokeObjectURL(u), 180000);
            nextHint();
            return;
        }

        let bestHtml = null;
        let bestScore = -1;
        state.files.forEach((file) => {
            const n = (file.name || '').toLowerCase().replace(/\\/g, '/');
            if (!n.endsWith('.html') && !n.endsWith('.htm')) return;
            const doc = String(file.doc || '').trim();
            if (!doc) return;
            let score = 1;
            if (n === 'index.html' || n.endsWith('/index.html')) score = 3;
            else if (n.endsWith('index.html')) score = 2;
            if (score > bestScore) {
                bestScore = score;
                bestHtml = doc;
            }
        });
        if (bestHtml) {
            const u = URL.createObjectURL(new Blob([bestHtml], { type: 'text/html;charset=utf-8' }));
            const w = window.open(u, '_blank', 'noopener,noreferrer');
            if (!w) {
                URL.revokeObjectURL(u);
                showToast('Pop-up blocked — allow pop-ups for this site.', 'error');
                return;
            }
            setTimeout(() => URL.revokeObjectURL(u), 180000);
            nextHint();
            return;
        }

        if (state.currentSession) {
            const w = window.open(`${window.location.origin}/${state.currentSession}/web`, '_blank', 'noopener,noreferrer');
            if (!w) {
                showToast('Pop-up blocked — allow pop-ups for this site.', 'error');
                return;
            }
            nextHint();
            return;
        }

        showToast('No HTML preview yet — Run on an .html file, or save index.html and try again.', 'info');
    }

    // ─── Editor Toolbar Events ───
    function initEditorToolbar() {
        if (!document.getElementById('back-to-dashboard') || !document.getElementById('panel-tabs')) return;
        const backBtn = document.getElementById('back-to-dashboard');
        backBtn.addEventListener('click', () => {
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

        document.getElementById('copy-publish-link')?.addEventListener('click', () => {
            const id = state.currentSession;
            if (!id) return;
            const url = `${window.location.origin}/${id}/web`;
            navigator.clipboard.writeText(url).then(() => showToast('Public /web preview link copied', 'success')).catch(() => {
                const input = document.createElement('input');
                input.value = url;
                document.body.appendChild(input);
                input.select();
                document.execCommand('copy');
                input.remove();
                showToast('Preview link copied', 'success');
            });
        });

        document.getElementById('editor-session-id')?.addEventListener('click', () => {
            document.getElementById('copy-session-link').click();
        });

        document.getElementById('statusbar-save')?.addEventListener('click', () => {
            manualSave();
        });

        // ─── Chat ───
        document.getElementById('chat-send-btn')?.addEventListener('click', sendChatMessage);
        document.getElementById('chat-input')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); sendChatMessage(); }
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
            openHtmlPreviewInNewTab();
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
                else if (action === 'import-github') importGitHubIntoCurrentSession();
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
                    const chatPanel = document.getElementById('chat-panel');
                    if (tree) tree.style.display = '';
                    if (extPanel) extPanel.style.display = 'none';
                    if (chatPanel) chatPanel.style.display = 'none';
                }
                else if (act === 'search') { state.editorView?.focus(); state.editorView?.trigger('toggleFind', 'actions.find'); }
                else if (act === 'source-control') {
                    if (sidebar) sidebar.style.display = '';
                    const tree = document.getElementById('file-tree');
                    const extPanel = document.getElementById('extensions-panel');
                    const chatPanel = document.getElementById('chat-panel');
                    if (tree) tree.style.display = '';
                    if (extPanel) extPanel.style.display = 'none';
                    if (chatPanel) chatPanel.style.display = 'none';
                    showToast('Source control: CodeMesh syncs automatically.', 'info');
                }
                else if (act === 'run') runCode();
                else if (act === 'extensions') {
                    if (sidebar) sidebar.style.display = '';
                    const tree = document.getElementById('file-tree');
                    const extPanel = document.getElementById('extensions-panel');
                    const chatPanel = document.getElementById('chat-panel');
                    if (tree) tree.style.display = 'none';
                    if (extPanel) extPanel.style.display = 'block';
                    if (chatPanel) chatPanel.style.display = 'none';
                }
                else if (act === 'chat') {
                    if (sidebar) sidebar.style.display = '';
                    const tree = document.getElementById('file-tree');
                    const extPanel = document.getElementById('extensions-panel');
                    const chatPanel = document.getElementById('chat-panel');
                    if (tree) tree.style.display = 'none';
                    if (extPanel) extPanel.style.display = 'none';
                    if (chatPanel) chatPanel.style.display = 'flex';
                    renderChatMessages();
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
            const name = prompt('Enter file name (e.g., main.cpp, app.js, index.html):');
            if (!name) return;
            const lang = inferLanguageFromFileName(name);
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
            if (!container2 || !splitContainer) return;
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
        document.getElementById('close-comments-btn')?.addEventListener('click', () => {
            const sb = document.getElementById('comments-sidebar');
            if (sb) sb.style.display = 'none';
            state.activeCommentLine = null;
        });

        document.getElementById('submit-comment-btn')?.addEventListener('click', () => {
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

        document.getElementById('new-comment-input')?.addEventListener('keydown', (e) => {
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
        const active = state.activeFileId && state.files.get(state.activeFileId);
        const language = active
            ? (active.language || inferLanguageFromFileName(active.name))
            : 'javascript';

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
        if (str == null) return '';
        const div = document.createElement('div');
        div.textContent = String(str);
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
        document.getElementById('admin-panel-btn')?.addEventListener('click', () => loadAdminPanel());
        document.getElementById('admin-back-btn')?.addEventListener('click', () => loadDashboard());

        document.querySelectorAll('.admin-tab').forEach(tab => {
            tab?.addEventListener('click', () => {
                document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');

                const target = tab.dataset.adminTab;
                const usersPanel = document.getElementById('admin-users-panel');
                const sessionsPanel = document.getElementById('admin-sessions-panel');
                const clashesPanel = document.getElementById('admin-clashes-panel');
                const filesPanel = document.getElementById('admin-files-panel');
                if (usersPanel) usersPanel.style.display = target === 'users' ? '' : 'none';
                if (sessionsPanel) sessionsPanel.style.display = target === 'sessions' ? '' : 'none';
                if (clashesPanel) {
                    clashesPanel.style.display = target === 'clashes' ? '' : 'none';
                    if (target === 'clashes') loadAdminClashes();
                }
                if (filesPanel) {
                    filesPanel.style.display = target === 'files' ? '' : 'none';
                    if (target === 'files') loadAdminFiles();
                }
            });
        });

        document.getElementById('admin-session-code-close')?.addEventListener('click', () => {
            const p = document.getElementById('admin-session-code-panel');
            if (p) p.style.display = 'none';
        });

        document.getElementById('admin-sessions-tbody')?.addEventListener('click', (e) => {
            const btn = e.target.closest('.admin-session-code-btn');
            if (btn && btn.dataset.sessionId) {
                window._adminViewSessionCode(btn.dataset.sessionId);
            }
        });

        document.getElementById('admin-clash-batch-btn')?.addEventListener('click', () => {
            runAdminClashBatch();
        });

        document.getElementById('admin-clash-submissions-close')?.addEventListener('click', () => {
            const p = document.getElementById('admin-clash-submissions-panel');
            if (p) p.style.display = 'none';
        });

        document.getElementById('admin-clashes-panel')?.addEventListener('click', async (e) => {
            const subsBtn = e.target.closest('.admin-clash-subs-btn');
            if (subsBtn && subsBtn.dataset.slug) {
                window._adminViewClashSubmissions(subsBtn.dataset.slug);
                return;
            }
            const delBtn = e.target.closest('.admin-delete-clash');
            if (delBtn && delBtn.dataset.slug) {
                const slug = delBtn.getAttribute('data-slug');
                if (!slug || !confirm('Delete clash ' + slug + ' and its submissions?')) return;
                try {
                    await api('/admin/clashes/' + encodeURIComponent(slug), { method: 'DELETE' });
                    showToast('Clash deleted', 'success');
                    loadAdminClashes();
                } catch (err) {
                    showToast(err.message, 'error');
                }
            }
        });

        document.getElementById('admin-upload-btn')?.addEventListener('click', () => document.getElementById('admin-file-input')?.click());
        document.getElementById('admin-file-input')?.addEventListener('change', handleAdminFileUpload);

        document.getElementById('admin-files-panel')?.addEventListener('click', (e) => {
            const btn = e.target.closest('.admin-delete-file');
            if (btn && btn.dataset.filename) window._adminDeleteFile(btn.dataset.filename);
        });
    }

    async function loadAdminPanel() {
        showView('admin');
        await Promise.all([loadAdminUsers(), loadAdminSessions(), loadAdminClashes(), loadAdminFiles()]);
    }

    async function loadAdminClashes() {
        const tbody = document.getElementById('admin-clashes-tbody');
        const countEl = document.getElementById('admin-clash-count');
        if (!tbody) return;
        try {
            const rows = await api('/admin/clashes');
            if (countEl) countEl.textContent = `${rows.length} clashes`;
            tbody.innerHTML = rows.length === 0
                ? '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:24px;">No clashes</td></tr>'
                : rows.map((r) => `
                    <tr>
                        <td><code>${escapeHtml(r.slug)}</code></td>
                        <td>${escapeHtml(r.title)}</td>
                        <td>${escapeHtml(r.mode)}</td>
                        <td>${escapeHtml(r.status || '—')}</td>
                        <td>${timeAgo(r.createdAt)}</td>
                        <td><div class="admin-actions">
                            <button type="button" class="btn btn-secondary btn-sm admin-clash-subs-btn" data-slug="${escapeHtml(r.slug)}">All code</button>
                            <button type="button" class="btn-delete admin-delete-clash" data-slug="${escapeHtml(r.slug)}">Delete</button>
                        </div></td>
                    </tr>`).join('');
        } catch (err) {
            if (countEl) countEl.textContent = '—';
            tbody.innerHTML = '<tr><td colspan="6">Failed to load</td></tr>';
        }
    }

    async function runAdminClashBatch() {
        const msg = document.getElementById('admin-clash-batch-msg');
        if (msg) msg.textContent = 'Running (Flash + Pro per item; may take several minutes)…';
        try {
            const count = document.getElementById('admin-clash-batch-count')?.value || '1';
            const mode = document.getElementById('admin-clash-batch-mode')?.value || 'fastest';
            const topic = document.getElementById('admin-clash-batch-topic')?.value || '';
            const roomDurationMinutes = Number(document.getElementById('admin-clash-batch-duration')?.value) || 15;
            const data = await api('/admin/clashes/batch', {
                method: 'POST',
                body: JSON.stringify({ count: parseInt(count, 10), mode, topic, roomDurationMinutes })
            });
            const ok = (data.created || []).length;
            const bad = (data.failed || []).length;
            if (msg) msg.textContent = `Created ${ok}, failed ${bad}. Flash: ${data.flashModel || ''} · Pro: ${data.proModel || ''}`;
            showToast(`Batch done: ${ok} created`, ok ? 'success' : 'info');
            loadAdminClashes();
        } catch (err) {
            if (msg) msg.textContent = err.message || 'Batch failed';
            showToast(err.message || 'Batch failed', 'error');
        }
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
                            <button type="button" class="btn btn-secondary btn-sm admin-session-code-btn" data-session-id="${escapeHtml(s.sessionId)}">View code</button>
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

    async function loadAdminFiles() {
        const countEl = document.getElementById('admin-file-count');
        const tbody = document.getElementById('admin-files-tbody');
        if (!tbody) return;
        const formatSize = (bytes) => bytes < 1024 ? bytes + ' B' : (bytes / 1024).toFixed(1) + ' KB';
        try {
            const files = await api('/admin/files');
            if (countEl) countEl.textContent = `${files.length} files`;
            tbody.innerHTML = files.length === 0
                ? '<tr><td colspan="4" style="color:var(--text-muted);text-align:center;padding:24px;">No files yet. Upload one above.</td></tr>'
                : files.map(f => `
                    <tr>
                        <td><a href="/uploads/${encodeURIComponent(f.name)}" target="_blank" rel="noopener">${escapeHtml(f.name)}</a></td>
                        <td>${formatSize(f.size)}</td>
                        <td>${timeAgo(f.uploadedAt)}</td>
                        <td>
                            <div class="admin-actions">
                                <a href="/uploads/${encodeURIComponent(f.name)}" target="_blank" rel="noopener" class="btn btn-secondary btn-sm">Open</a>
                                <button class="btn-delete admin-delete-file" data-filename="${escapeHtml(f.name)}">Delete</button>
                            </div>
                        </td>
                    </tr>
                `).join('');
        } catch (err) {
            showToast('Failed to load files: ' + err.message, 'error');
            if (countEl) countEl.textContent = '—';
            tbody.innerHTML = '<tr><td colspan="4" style="color:var(--text-muted);text-align:center;padding:24px;">Could not load files. You can still upload above.</td></tr>';
        }
    }

    async function handleAdminFileUpload(e) {
        const input = e.target;
        const files = input.files;
        if (!files || files.length === 0) return;
        for (let i = 0; i < files.length; i++) {
            const formData = new FormData();
            formData.append('file', files[i]);
            try {
                await api('/admin/files', { method: 'POST', body: formData });
                showToast(`Uploaded: ${files[i].name}`, 'success');
            } catch (err) {
                showToast(`Upload failed: ${err.message}`, 'error');
            }
        }
        input.value = '';
        loadAdminFiles();
    }

    window._adminViewClashSubmissions = async function (slug) {
        const panel = document.getElementById('admin-clash-submissions-panel');
        const pre = document.getElementById('admin-clash-submissions-pre');
        const head = document.getElementById('admin-clash-submissions-heading');
        if (!panel || !pre) return;
        pre.textContent = 'Loading…';
        panel.style.display = '';
        if (head) head.textContent = 'Clash submissions: ' + slug;
        try {
            const data = await api('/admin/clashes/' + encodeURIComponent(slug) + '/submissions');
            const parts = [];
            parts.push(`# ${data.title || slug} (${data.slug})  mode=${data.mode || ''}  submissions=${data.count}`);
            (data.submissions || []).forEach((s, i) => {
                parts.push('');
                parts.push(`--- #${i + 1} ${s.createdAt ? new Date(s.createdAt).toISOString() : ''} ---`);
                parts.push(`user: ${s.username} <${s.email || ''}>`);
                parts.push(`language: ${s.language}  accepted: ${s.accepted}  chars: ${s.charCount}  totalTimeMs: ${s.totalTimeMs}`);
                parts.push('');
                parts.push(s.code || '(no code)');
            });
            pre.textContent = parts.join('\n');
            panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } catch (err) {
            pre.textContent = 'Error: ' + (err.message || String(err));
        }
    };

    window._adminViewSessionCode = async function (sessionId) {
        const panel = document.getElementById('admin-session-code-panel');
        const pre = document.getElementById('admin-session-code-pre');
        if (!panel || !pre) return;
        pre.textContent = 'Loading…';
        panel.style.display = '';
        try {
            const d = await api('/admin/sessions/' + encodeURIComponent(sessionId) + '/detail');
            const parts = [];
            parts.push('sessionId: ' + d.sessionId);
            parts.push('title: ' + d.title);
            parts.push('language: ' + (d.language || ''));
            if (d.owner) parts.push('owner: ' + (d.owner.username || '') + ' <' + (d.owner.email || '') + '>');
            if (d.collaborators && d.collaborators.length) {
                parts.push('collaborators:');
                d.collaborators.forEach((c) => {
                    parts.push('  - ' + (c.username || '?') + ' <' + (c.email || '') + '>  role=' + (c.role || ''));
                });
            }
            if (d.code) parts.push('\n--- legacy code field ---\n' + d.code);
            (d.files || []).forEach((f) => {
                parts.push('\n--- file: ' + (f.name || '') + ' (' + (f.language || '') + ') ---\n' + (f.content || ''));
            });
            pre.textContent = parts.join('\n');
        } catch (err) {
            pre.textContent = 'Error: ' + (err.message || String(err));
        }
    };

    window._adminDeleteFile = async function (fileId) {
        if (!confirm('Delete this file?')) return;
        try {
            const result = await api(`/admin/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
            showToast(result.message, 'success');
            loadAdminFiles();
        } catch (err) {
            showToast(err.message, 'error');
        }
    };

    // ─── Clash / Grader (CodinGame-style) ───
    function clearClashRoomTimers() {
        if (clashPollInterval) {
            clearInterval(clashPollInterval);
            clashPollInterval = null;
        }
        if (clashTickInterval) {
            clearInterval(clashTickInterval);
            clashTickInterval = null;
        }
        if (clashLobbyTickInterval) {
            clearInterval(clashLobbyTickInterval);
            clashLobbyTickInterval = null;
        }
        disposeClashMonaco();
    }

    function disposeClashMonaco() {
        if (clashMonacoEditor) {
            try {
                clashMonacoEditor.dispose();
            } catch (_) { /* ignore */ }
            clashMonacoEditor = null;
        }
        const mc = document.getElementById('clash-monaco-container');
        const ta = document.getElementById('clash-code-input');
        if (mc) {
            mc.innerHTML = '';
            mc.style.display = 'none';
        }
        if (ta) ta.style.display = '';
    }

    async function initClashMonacoLive() {
        const container = document.getElementById('clash-monaco-container');
        const ta = document.getElementById('clash-code-input');
        if (!container || !ta) return;
        try {
            await loadMonaco();
            disposeClashMonaco();
            const lang = document.getElementById('clash-lang-select')?.value || 'python';
            clashMonacoEditor = window.monaco.editor.create(container, {
                value: ta.value || '',
                language: mapLanguageToMonaco(lang),
                theme: 'vs-dark',
                automaticLayout: true,
                minimap: { enabled: false },
                wordWrap: 'on'
            });
            container.style.display = '';
            ta.style.display = 'none';
            clashMonacoEditor.onDidChangeModelContent(() => {
                ta.value = clashMonacoEditor.getValue();
            });
        } catch (e) {
            console.warn('Clash Monaco:', e);
        }
    }

    function formatClashCountdown(totalSec) {
        const sec = Math.max(0, totalSec | 0);
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    function setClashCreateModalOpen(open) {
        const m = document.getElementById('clash-create-modal');
        if (!m) return;
        m.style.display = open ? 'flex' : 'none';
        m.setAttribute('aria-hidden', open ? 'false' : 'true');
    }

    function buildClashLobbySlotHtml(participants, maxPlayers) {
        const names = (participants || []).map((p) => (p && p.username) || 'Player');
        const cap = Math.min(20, Math.max(1, maxPlayers || 50));
        let html = '';
        for (let i = 0; i < cap; i++) {
            if (i < names.length) {
                const raw = names[i];
                const short = raw.length > 14 ? `${escapeHtml(raw.slice(0, 14))}…` : escapeHtml(raw);
                html += `<div class="coc-slot coc-slot-filled"><span class="coc-slot-name">${short}</span></div>`;
            } else {
                html += '<div class="coc-slot coc-slot-wait"><span class="coc-slot-wait">Waiting for player…</span></div>';
            }
        }
        return html;
    }

    async function openClashHub() {
        clearClashRoomTimers();
        currentClashSlug = null;
        setClashCreateModalOpen(false);
        const leaveBtn = document.getElementById('clash-leave-room-btn');
        if (leaveBtn) leaveBtn.style.display = 'none';
        showView('clash');
        const hub = document.getElementById('clash-hub-panel');
        const room = document.getElementById('clash-room-panel');
        if (hub) hub.style.display = '';
        if (room) room.style.display = 'none';
        const t = document.getElementById('clash-toolbar-title');
        if (t) t.textContent = 'Clash of Code';
        setDocumentTitle('Clash · CodeMesh');
        const hubPath = clashHubPath();
        const path = (window.location.pathname.replace(/\/+$/, '') || '/');
        const hubNorm = (hubPath.replace(/\/+$/, '') || '/');
        if (path !== hubNorm) {
            history.replaceState({}, '', hubPath);
        }
        const list = document.getElementById('clash-list');
        if (!list) return;
        list.innerHTML = '<li class="coc-aside-muted">Loading…</li>';
        try {
            const rows = await api('/grader/clashes');
            list.innerHTML = rows.length
                ? rows.map((r) => {
                    const st = r.status ? escapeHtml(r.status) : 'live';
                    const modeLabel = r.mode ? escapeHtml(r.mode) : '—';
                    return `<li class="clash-li coc-hub-item"><a href="#" class="clash-open" data-slug="${escapeHtml(r.slug)}">${escapeHtml(r.title)}</a> <span class="coc-aside-muted">${modeLabel}</span> <span class="clash-badge clash-badge-sm">${st}</span></li>`;
                }).join('')
                : '<li class="coc-aside-muted">No rooms yet — start a private clash above.</li>';
            list.querySelectorAll('a.clash-open').forEach((a) => {
                a.addEventListener('click', (e) => {
                    e.preventDefault();
                    const slug = a.getAttribute('data-slug');
                    if (slug) {
                        history.pushState({}, '', clashRoomUrlPath(slug));
                        openClashRoom(slug);
                    }
                });
            });
        } catch (err) {
            list.innerHTML = '<li class="coc-aside-muted">Could not load clashes.</li>';
        }
    }

    function applyClashRoomPayload(slug, c) {
        const banner = document.getElementById('clash-room-banner');
        const lobbyLayout = document.getElementById('clash-lobby-layout');
        const meta = document.getElementById('clash-room-meta');
        const stEl = document.getElementById('clash-room-statement');
        const samples = document.getElementById('clash-room-samples');
        const pub = document.getElementById('clash-room-public-tests');
        const langSel = document.getElementById('clash-lang-select');
        const editorBlock = document.getElementById('clash-editor-block');
        const submitBtn = document.getElementById('clash-submit-btn');
        const playground = document.getElementById('clash-playground');
        const shareInput = document.getElementById('clash-share-url-input');
        const liveSub = document.getElementById('clash-live-subtitle');
        const status = c.status || 'live';
        const ph = !!c.problemHidden;
        const legacyLive = !c.status;
        const problemVisible = !ph && (legacyLive || status === 'live' || status === 'ended');

        const showLobby = !!(c.roomPhase && ['preparing', 'lobby', 'countdown'].includes(c.roomPhase));
        const inviteUrl = window.location.origin + clashRoomUrlPath(slug);
        if (shareInput) shareInput.value = inviteUrl;

        if (lobbyLayout) {
            if (showLobby) {
                if (clashLobbyTickInterval) {
                    clearInterval(clashLobbyTickInterval);
                    clashLobbyTickInterval = null;
                }
                lobbyLayout.style.display = 'grid';

                const msgs = document.getElementById('clash-lobby-messages');
                if (msgs) {
                    msgs.innerHTML = `<p><strong>${escapeHtml(c.message || '')}</strong></p><p class="coc-aside-muted">This room is private — no puzzle spoilers until the countdown ends. <span class="coc-warn-inline">Registered accounts only</span> to join and submit.</p>`;
                }
                const pc = document.getElementById('clash-lobby-player-count');
                if (pc) pc.textContent = `${c.participantCount || 0} / ${c.maxPlayers || 50}`;
                const modesEl = document.getElementById('clash-lobby-modes');
                if (modesEl) {
                    modesEl.textContent = (c.allowedModesPick && c.allowedModesPick.length)
                        ? c.allowedModesPick.join(', ')
                        : '—';
                }
                const langsEl = document.getElementById('clash-lobby-langs');
                if (langsEl) {
                    langsEl.textContent = c.languagesAll
                        ? 'All sandbox languages'
                        : `${(c.allowedLanguages || []).slice(0, 6).join(', ')}${(c.allowedLanguages || []).length > 6 ? '…' : ''}`;
                }
                const slots = document.getElementById('clash-lobby-slots');
                if (slots) slots.innerHTML = buildClashLobbySlotHtml(c.participants, c.maxPlayers);
                const asideNote = document.getElementById('clash-lobby-aside-note');
                if (asideNote) {
                    asideNote.textContent = c.isOwner
                        ? 'You are the host — start the countdown when players are ready.'
                        : 'Wait for the host to start the countdown.';
                }
                const cdLabel = document.getElementById('clash-lobby-cd-label');
                const cdDigits = document.getElementById('clash-lobby-cd');
                if (c.roomPhase === 'countdown' && c.countdownEndsAt) {
                    if (cdLabel) cdLabel.textContent = 'Clash starts in';
                    const startSec = c.countdownSecondsRemaining != null ? c.countdownSecondsRemaining : 0;
                    if (cdDigits) cdDigits.textContent = formatClashCountdown(startSec);
                    const endMs = new Date(c.countdownEndsAt).getTime();
                    clashLobbyTickInterval = setInterval(() => {
                        if (currentClashSlug !== slug) return;
                        const left = Math.max(0, Math.floor((endMs - Date.now()) / 1000));
                        if (cdDigits) cdDigits.textContent = formatClashCountdown(left);
                        if (left <= 0) {
                            clearInterval(clashLobbyTickInterval);
                            clashLobbyTickInterval = null;
                            openClashRoom(slug);
                        }
                    }, 1000);
                } else {
                    if (cdLabel) cdLabel.textContent = 'Clash starts in';
                    if (cdDigits) cdDigits.textContent = '—:—';
                }
                const cta = document.getElementById('clash-lobby-cta-row');
                if (cta) {
                    cta.innerHTML = c.canStart
                        ? '<button type="button" class="coc-btn-start-countdown" id="clash-start-btn">Start countdown</button>'
                        : '';
                }
            } else {
                lobbyLayout.style.display = 'none';
                if (clashLobbyTickInterval) {
                    clearInterval(clashLobbyTickInterval);
                    clashLobbyTickInterval = null;
                }
            }
        }

        if (banner) {
            if (showLobby) {
                banner.style.display = 'none';
                banner.innerHTML = '';
            } else {
                banner.style.display = '';
                let inner = '';
                if (status === 'verifying' && !c.roomPhase) {
                    inner = `<p class="coc-aside-muted">${escapeHtml(c.message || 'Pro model is reviewing…')}</p>`;
                } else if (status === 'rejected') {
                    inner = `<p class="clash-bad">Rejected.</p><p class="coc-aside-muted">${escapeHtml(c.verificationReason || '')}</p>`;
                } else if (status === 'ready' && !c.roomPhase) {
                    inner = `<p class="coc-aside-muted">${escapeHtml(c.message || '')}</p>`;
                    if (c.canStart) {
                        inner += `<p><button type="button" class="coc-btn-start-countdown" id="clash-start-btn">Start (${Math.round((c.roomDurationMs || 900000) / 60000)} min match)</button></p>`;
                    }
                } else if (status === 'live' && !c.endsAt) {
                    banner.style.display = 'none';
                } else if (status === 'live') {
                    const left = typeof c.secondsRemaining === 'number' ? c.secondsRemaining : null;
                    inner = `<div class="coc-banner-live-row"><span class="clash-ok">Match live</span><span class="coc-aside-muted">Time left</span> <span id="clash-countdown-display" class="coc-live-timer">${left != null ? formatClashCountdown(left) : '—'}</span></div>`;
                } else if (status === 'ended') {
                    inner = '<p class="coc-aside-muted">Match ended — leaderboard is below; submissions are closed.</p>';
                } else {
                    banner.style.display = 'none';
                }
                if (banner.style.display !== 'none') {
                    banner.innerHTML = inner;
                }
            }
        }

        if (meta) {
            meta.style.display = showLobby ? 'none' : '';
            if (!showLobby) {
                if (ph) {
                    meta.innerHTML = `<span class="clash-badge">${escapeHtml(c.roomPhase || '')}</span> <span class="coc-aside-muted">Private room</span> <code>${escapeHtml(slug)}</code> <span class="clash-badge">${escapeHtml(status)}</span>`;
                } else {
                    meta.innerHTML = `<span class="clash-badge">${escapeHtml(c.mode)}</span> <span class="coc-aside-muted">${escapeHtml(c.title)}</span> <span class="clash-badge">${escapeHtml(status)}</span>`;
                }
            }
        }

        if (liveSub) {
            if (problemVisible && status === 'live' && c.mode) {
                liveSub.style.display = '';
                liveSub.textContent = `${c.title || 'Clash'} · ${c.mode}`;
            } else {
                liveSub.style.display = 'none';
                liveSub.textContent = '';
            }
        }

        if (playground) {
            playground.style.display = problemVisible ? 'grid' : 'none';
        }

        if (stEl) {
            stEl.innerHTML = (problemVisible && c.statement)
                ? `<div class="clash-md">${escapeHtml(c.statement).replace(/\n/g, '<br>')}</div>`
                : (problemVisible ? '' : '');
        }
        if (samples) {
            if (problemVisible && (c.samples || []).length) {
                samples.innerHTML = '<h4>Samples</h4>' + (c.samples || []).map((s, i) => `
                    <div class="clash-io-pair"><strong>In ${i + 1}</strong><pre>${escapeHtml(s.input)}</pre><strong>Out ${i + 1}</strong><pre>${escapeHtml(s.output)}</pre></div>`).join('');
            } else {
                samples.innerHTML = problemVisible ? '<h4>Samples</h4><p class="coc-aside-muted">No samples.</p>' : '';
            }
        }
        if (pub) {
            const pts = c.publicTests || [];
            if (problemVisible && pts.length) {
                pub.innerHTML = '<h4>Public tests</h4>' + pts.map((s, i) => `
                    <div class="clash-io-pair"><strong>Public in ${i + 1}</strong><pre>${escapeHtml(s.input)}</pre><strong>Public out ${i + 1}</strong><pre>${escapeHtml(s.output)}</pre></div>`).join('');
            } else {
                pub.innerHTML = '';
            }
        }
        if (langSel) {
            const langs = c.allowedLanguages || ['python'];
            const prevLang = langSel.value;
            langSel.innerHTML = langs.map((l) => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join('');
            const pick = langs.includes(prevLang) ? prevLang : langs[0];
            if (pick) langSel.value = pick;
            if (clashMonacoEditor && window.monaco) {
                try {
                    window.monaco.editor.setModelLanguage(
                        clashMonacoEditor.getModel(),
                        mapLanguageToMonaco(langSel.value)
                    );
                } catch (_) { /* ignore */ }
            }
        }

        const canEdit = status === 'live' && (c.secondsRemaining == null || c.secondsRemaining > 0);
        if (editorBlock) {
            editorBlock.style.display = (status === 'live' || status === 'ended' || legacyLive) ? '' : 'none';
        }
        if (submitBtn) {
            submitBtn.style.display = canEdit ? '' : 'none';
        }

        if (problemVisible && canEdit) {
            if (!clashMonacoEditor) initClashMonacoLive();
        } else {
            disposeClashMonaco();
        }

        if (status === 'live' && c.endsAt) {
            if (clashTickInterval) clearInterval(clashTickInterval);
            const endsMs = new Date(c.endsAt).getTime();
            clashTickInterval = setInterval(() => {
                if (currentClashSlug !== slug) return;
                const left = Math.max(0, Math.floor((endsMs - Date.now()) / 1000));
                const disp = document.getElementById('clash-countdown-display');
                if (disp) disp.textContent = formatClashCountdown(left);
                if (left <= 0) {
                    clearInterval(clashTickInterval);
                    clashTickInterval = null;
                    openClashRoom(slug);
                }
            }, 1000);
        }
    }

    async function openClashRoom(slug) {
        clearClashRoomTimers();
        currentClashSlug = slug;
        showView('clash');
        const hub = document.getElementById('clash-hub-panel');
        const room = document.getElementById('clash-room-panel');
        if (hub) hub.style.display = 'none';
        if (room) room.style.display = '';
        const leaveBtn = document.getElementById('clash-leave-room-btn');
        if (leaveBtn) leaveBtn.style.display = '';
        const t = document.getElementById('clash-toolbar-title');
        if (t) t.textContent = 'Clash of Code';
        setDocumentTitle(`${slug} · Clash · CodeMesh`);
        const canon = clashRoomUrlPath(slug);
        const cur = window.location.pathname.replace(/\/+$/, '') || '/';
        const canonNorm = canon.replace(/\/+$/, '') || '/';
        if (cur !== canonNorm) {
            history.replaceState({}, '', canon);
        }
        const meta = document.getElementById('clash-room-meta');
        const result = document.getElementById('clash-result');
        if (result) {
            result.style.display = 'none';
            result.innerHTML = '';
        }
        try {
            const c = await api('/grader/clashes/' + encodeURIComponent(slug));
            applyClashRoomPayload(slug, c);

            function clashPayloadNeedsPoll(payload) {
                if (!payload || payload.status === 'rejected') return false;
                if (payload.status === 'verifying') return true;
                const rp = payload.roomPhase || '';
                if (payload.problemHidden && ['preparing', 'lobby', 'countdown'].includes(rp)) return true;
                return false;
            }

            if (clashPayloadNeedsPoll(c)) {
                let prevSnap = { status: c.status, problemHidden: !!c.problemHidden, roomPhase: c.roomPhase || '' };
                clashPollInterval = setInterval(async () => {
                    if (currentClashSlug !== slug) return;
                    try {
                        const c2 = await api('/grader/clashes/' + encodeURIComponent(slug));
                        applyClashRoomPayload(slug, c2);
                        if (!clashPayloadNeedsPoll(c2)) {
                            clearInterval(clashPollInterval);
                            clashPollInterval = null;
                            if (c2.status === 'rejected') {
                                showToast('Clash did not pass review', 'error');
                            } else if (prevSnap.status === 'verifying' && c2.status === 'ready' && c2.isOwner && c2.roomPhase === 'lobby') {
                                showToast('Puzzle validated — invite players, then start the countdown.', 'success');
                            } else if (prevSnap.status === 'verifying' && c2.status === 'ready' && c2.isOwner && !c2.roomPhase) {
                                showToast('Review passed — start the match when you are ready.', 'success');
                            } else if (prevSnap.problemHidden && !c2.problemHidden && c2.status === 'live') {
                                showToast('Match is live — puzzle unlocked.', 'success');
                            }
                        }
                        prevSnap = { status: c2.status, problemHidden: !!c2.problemHidden, roomPhase: c2.roomPhase || '' };
                    } catch (_) { /* keep polling */ }
                }, 2500);
            }
        } catch (err) {
            if (meta) {
                meta.style.display = '';
                meta.innerHTML = '<p class="clash-bad">Clash not found or failed to load.</p>';
            }
        }
        await loadClashLeaderboard(slug);
    }

    async function startClash() {
        const slug = currentClashSlug;
        if (!slug) return;
        try {
            const body = await api('/grader/clashes/' + encodeURIComponent(slug) + '/start', { method: 'POST' });
            const msg = body && body.message
                ? body.message
                : (body && body.roomPhase === 'countdown' ? 'Countdown started.' : 'Match started.');
            showToast(msg, 'success');
            await openClashRoom(slug);
        } catch (err) {
            showToast(err.message || 'Could not start', 'error');
        }
    }

    async function loadClashLeaderboard(slug) {
        const el = document.getElementById('clash-leaderboard');
        if (!el) return;
        try {
            const data = await api('/grader/clashes/' + encodeURIComponent(slug) + '/leaderboard');
            const rows = data.leaderboard || [];
            el.innerHTML = rows.length
                ? '<table class="clash-table"><thead><tr><th>#</th><th>User</th><th>Time ms</th><th>Chars</th><th>Lang</th></tr></thead><tbody>'
                + rows.map((r) => `<tr><td>${r.rank}</td><td>${escapeHtml(r.username)}</td><td>${r.totalTimeMs}</td><td>${r.charCount}</td><td>${escapeHtml(r.language)}</td></tr>`).join('')
                + '</tbody></table>'
                : '<p class="coc-aside-muted">No accepted submissions yet.</p>';
        } catch (e) {
            el.textContent = 'Could not load leaderboard.';
        }
    }

    async function createClashFlow() {
        const msg = document.getElementById('clash-create-msg');
        if (msg) msg.textContent = 'Creating room…';
        try {
            const modeEls = document.querySelectorAll('.clash-mode-cb:checked');
            const allowedModes = Array.from(modeEls).map((el) => el.value).filter(Boolean);
            if (!allowedModes.length) {
                if (msg) msg.textContent = 'Pick at least one mode.';
                showToast('Select at least one clash mode', 'error');
                return;
            }
            const languagesAll = !!document.getElementById('clash-lang-all')?.checked;
            const source = document.getElementById('clash-source')?.value || 'auto';
            const topic = document.getElementById('clash-create-topic')?.value || '';
            const lobbyCountdownMinutes = Number(document.getElementById('clash-lobby-countdown')?.value) || 5;
            const roomDurationMinutes = Number(document.getElementById('clash-create-duration')?.value) || 15;
            const r = await api('/grader/clashes', {
                method: 'POST',
                body: JSON.stringify({
                    allowedModes,
                    languagesAll,
                    source,
                    topic,
                    lobbyCountdownMinutes,
                    roomDurationMinutes
                })
            });
            if (msg) msg.textContent = r.message || ('Room ' + r.slug);
            setClashCreateModalOpen(false);
            history.pushState({}, '', clashRoomUrlPath(r.slug));
            await openClashRoom(r.slug);
        } catch (err) {
            if (msg) msg.textContent = err.message || 'Failed';
            showToast(err.message || 'Create failed', 'error');
        }
    }

    async function submitClash() {
        const slug = currentClashSlug;
        if (!slug) return;
        const lang = document.getElementById('clash-lang-select')?.value;
        const ta = document.getElementById('clash-code-input');
        let code = (ta && ta.value) || '';
        if (clashMonacoEditor) {
            try {
                code = clashMonacoEditor.getValue();
            } catch (_) { /* use textarea */ }
        }
        if (!code.trim()) {
            showToast('Paste your solution first', 'error');
            return;
        }
        try {
            const res = await api('/grader/clashes/' + encodeURIComponent(slug) + '/submit', {
                method: 'POST',
                body: JSON.stringify({ language: lang, code })
            });
            const el = document.getElementById('clash-result');
            if (!el) return;
            el.style.display = '';
            if (res.accepted) {
                el.innerHTML = `<p class="clash-ok">All tests passed.</p><p class="clash-muted">Total time ${res.totalTimeMs} ms · ${res.charCount} characters</p>`;
            } else {
                let html = '<p class="clash-bad">Some tests failed.</p>';
                (res.failures || []).forEach((f) => {
                    html += `<div class="clash-fail"><h4>Test #${f.index + 1}</h4>`;
                    if (f.inputPreview) html += `<p class="clash-muted">Input (preview)</p><pre class="clash-io">${escapeHtml(f.inputPreview)}</pre>`;
                    html += `<p><strong>Expected</strong></p><pre class="clash-io">${escapeHtml(f.expected)}</pre>`;
                    html += `<p><strong>Your output</strong></p><pre class="clash-io">${escapeHtml(f.actual)}</pre>`;
                    if (f.stderr) html += `<p><strong>Stderr</strong></p><pre class="clash-io">${escapeHtml(f.stderr)}</pre>`;
                    html += '</div>';
                });
                el.innerHTML = html;
            }
            showToast(res.accepted ? 'Accepted!' : 'Try again', res.accepted ? 'success' : 'info');
            await loadClashLeaderboard(slug);
        } catch (err) {
            showToast(err.message || 'Submit failed', 'error');
        }
    }

    async function joinClashRoom() {
        const slug = currentClashSlug;
        if (!slug) return;
        try {
            await api('/grader/clashes/' + encodeURIComponent(slug) + '/join', { method: 'POST', body: JSON.stringify({}) });
            showToast('You joined the room', 'success');
            await openClashRoom(slug);
        } catch (err) {
            showToast(err.message || 'Join failed — use a registered account', 'error');
        }
    }

    function initClashUi() {
        document.getElementById('clash-open-create-modal')?.addEventListener('click', () => { setClashCreateModalOpen(true); });
        document.getElementById('clash-create-btn')?.addEventListener('click', () => { createClashFlow(); });
        document.querySelectorAll('[data-clash-modal-close]').forEach((el) => {
            el.addEventListener('click', () => { setClashCreateModalOpen(false); });
        });
        document.getElementById('clash-copy-invite-btn')?.addEventListener('click', (e) => {
            e.preventDefault();
            const inp = document.getElementById('clash-share-url-input');
            const url = (inp && inp.value) || '';
            if (url && navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(url).then(() => showToast('Invite link copied', 'success')).catch(() => showToast('Could not copy link', 'error'));
            } else if (url) {
                showToast(url, 'info');
            }
        });
        document.getElementById('clash-leave-room-btn')?.addEventListener('click', (e) => {
            e.preventDefault();
            history.pushState({}, '', clashHubPath());
            openClashHub();
        });
        document.getElementById('clash-submit-btn')?.addEventListener('click', () => { submitClash(); });
        document.getElementById('clash-lang-select')?.addEventListener('change', () => {
            if (!clashMonacoEditor || !window.monaco) return;
            const v = document.getElementById('clash-lang-select')?.value;
            if (!v) return;
            try {
                window.monaco.editor.setModelLanguage(clashMonacoEditor.getModel(), mapLanguageToMonaco(v));
            } catch (_) { /* ignore */ }
        });
        document.getElementById('clash-hub-link')?.addEventListener('click', (e) => {
            e.preventDefault();
            history.pushState({}, '', clashHubPath());
            openClashHub();
        });
        document.getElementById('clash-view')?.addEventListener('click', (e) => {
            if (e.target && e.target.id === 'clash-join-btn') {
                e.preventDefault();
                joinClashRoom();
                return;
            }
            if (e.target && e.target.id === 'clash-start-btn') {
                e.preventDefault();
                startClash();
            }
        });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (state.currentView !== 'clash') return;
            const m = document.getElementById('clash-create-modal');
            if (m && m.style.display === 'flex') setClashCreateModalOpen(false);
        });
    }

    // ─── App Initialization ───
    function init() {
        initAuthTabs();
        initAuth();
        initResetPassword();
        initDashboard();
        initEditorToolbar();
        initAdminPanel();
        initPublishViewControls();
        initClashUi();

        window.addEventListener('popstate', () => {
            const p = parseAppPath();
            if (p && p.mode === 'clash-hub') {
                openClashHub();
                return;
            }
            if (p && p.mode === 'clash-room') {
                openClashRoom(p.clashSlug);
            }
        });

        // Remove loading overlay; default to guest so share URLs and "New Session" work without login
        setTimeout(async () => {
            const overlay = document.getElementById('loading-overlay');
            overlay.classList.add('hidden');

            const params = new URLSearchParams(window.location.search);
            if (window.location.pathname === '/reset-password' && params.get('token')) {
                showView('reset-password');
                const container = document.getElementById('reset-particles');
                if (container) initParticlesIn(container);
                return;
            }

            const pathInfo = parseAppPath();
            const skipAutoGuest = sessionStorage.getItem('codemesh_explicit_logout') === '1';
            if (!pathInfo && skipAutoGuest) {
                showView('auth');
                initParticles();
                return;
            }

            try {
                await ensureGuestIfNeeded();
            } catch (err) {
                showToast(err.message || 'Could not start a session', 'error');
                showView('auth');
                initParticles();
                return;
            }

            if (pathInfo && pathInfo.mode === 'publish') {
                await openPublish(pathInfo.sessionId, pathInfo.publishPath);
                return;
            }
            if (pathInfo && pathInfo.mode === 'editor') {
                await openEditor(pathInfo.sessionId);
                return;
            }
            if (pathInfo && pathInfo.mode === 'admin-host') {
                if (!state.user || state.user.role !== 'admin') {
                    showView('auth');
                    initParticles();
                    showToast('Sign in with an admin account to use admin.codemesh.org.', 'info');
                    return;
                }
                await loadAdminPanel();
                return;
            }
            if (pathInfo && pathInfo.mode === 'clash-hub') {
                await openClashHub();
                return;
            }
            if (pathInfo && pathInfo.mode === 'clash-room') {
                await openClashRoom(pathInfo.clashSlug);
                return;
            }

            loadDashboard();
        }, 220);
    }

    // Start app when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
