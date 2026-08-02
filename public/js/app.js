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
        tabOrder: [], // display order for open tabs (drag to reorder)
        defaultJoinRole: 'editor', // default for new guests (owner sets)
        allowCollaboratorCopy: false, // owner/admin can allow guests to copy code
        guestCodeVisibleUntil: null,
        guestCodeVisibility: { status: 'forever', expiresAt: null, remainingMs: null },
        codeHiddenFromGuest: false,
        codeVisibilityCountdownTimer: null,
        referencePdf: null, // { url, originalName } | null
        pdfSplitVisible: false,
        sessionOwnerId: null,
        sessionIsPublic: true,
        sessionHasClassKey: false,
        pendingClassKey: null,
        splitEditor: null,
        splitActive: false,
        /** Right pane: local test buffer (name stem synced from left tab, language chosen separately) */
        splitScratch: { language: 'python', doc: '', sourceStem: '' },
        focusedPane: 'primary', // 'primary' | 'split'
        terminal: null,
        /** Folder paths (e.g. `routes`) collapsed in explorer; absent = expanded */
        fileTreeCollapsed: new Set()
    };

    let xtermCtorCached = null;

    const SPLIT_SCRATCH_ID = '__split_test__';
    const EDITOR_FONT_FAMILY = "'JetBrains Mono', 'Noto Sans Mono', 'Noto Sans Thai', 'Sarabun', 'Courier New', monospace";
    const SPLIT_LANG_OPTIONS = [
        ['python', 'Python'],
        ['cpp', 'C++'],
        ['c', 'C'],
        ['java', 'Java'],
        ['javascript', 'JavaScript'],
        ['typescript', 'TypeScript'],
        ['csharp', 'C#'],
        ['go', 'Go'],
        ['rust', 'Rust'],
        ['php', 'PHP'],
        ['ruby', 'Ruby'],
        ['html', 'HTML'],
        ['plaintext', 'Plain Text']
    ];

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

        const raw = await res.text();
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        let data = null;
        if (raw.length) {
            const looksJson = ct.includes('application/json')
                || raw.trimStart().startsWith('{')
                || raw.trimStart().startsWith('[');
            if (looksJson) {
                try {
                    data = JSON.parse(raw);
                } catch (_) {
                    const snippet = raw.slice(0, 160).replace(/\s+/g, ' ').trim();
                    throw new Error(
                        res.ok
                            ? 'Invalid JSON from server'
                            : `Server error (${res.status})${snippet ? `: ${snippet}` : ''}`
                    );
                }
            } else {
                const snippet = raw.slice(0, 200).replace(/\s+/g, ' ').trim();
                throw new Error(
                    snippet
                        ? `Server error (${res.status}): ${snippet}`
                        : `Server error (${res.status}) — non-JSON response`
                );
            }
        } else {
            data = {};
            if (!res.ok) {
                throw new Error(
                    `Empty response (${res.status}). The server or proxy may have timed out — try “Bank only”, shorten the request, or retry in a moment.`
                );
            }
        }
        if (!res.ok) {
            const err = new Error((data && data.error) || `Request failed (${res.status})`);
            err.status = res.status;
            err.code = data && data.code;
            err.payload = data;
            throw err;
        }
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
    const SESSION_ID_UNICODE_RE = /^[\p{L}\p{N}_-]{3,50}$/u;

    function decodeUrlPathSegment(seg) {
        try { return decodeURIComponent(String(seg)); } catch (_) { return String(seg); }
    }

    function isValidSessionIdClient(sid) {
        if (!sid || !SESSION_ID_UNICODE_RE.test(sid)) return false;
        return !RESERVED_PATH_SEGMENTS.has(sid.toLowerCase());
    }

    /** URL path for a session (UTF-8 session IDs are percent-encoded). */
    function sessionEditorPath(sessionId) {
        return '/' + encodeURIComponent(sessionId);
    }

    /** Browser PDF viewer zoom (iframe hash); also scales DOCX HTML. */
    let sessionPdfZoom = 100;

    const docAnnotate = {
        tool: null, // null | 'pen' | 'eraser'
        color: '#111111',
        width: 2.5,
        strokes: [],
        current: null,
        docKey: null
    };

    const docxEdit = {
        active: false,
        dirty: false,
        saving: false,
        bound: false
    };

    function sessionPdfAbsoluteUrl(url) {
        if (!url) return '';
        return url.startsWith('http') ? url : (window.location.origin + url);
    }

    function detectReferenceKindClient(originalName, mimeType, kind) {
        if (kind === 'pdf' || kind === 'doc' || kind === 'docx') return kind;
        const name = String(originalName || '').toLowerCase();
        const mime = String(mimeType || '').toLowerCase();
        if (mime.includes('pdf') || name.endsWith('.pdf')) return 'pdf';
        if (mime.includes('wordprocessingml') || name.endsWith('.docx')) return 'docx';
        if (mime.includes('msword') || name.endsWith('.doc')) return 'doc';
        return 'pdf';
    }

    function getReferenceDocKind(doc) {
        if (!doc) return 'pdf';
        return detectReferenceKindClient(doc.originalName, doc.mimeType, doc.kind);
    }

    function buildSessionPdfIframeSrc(url) {
        const abs = sessionPdfAbsoluteUrl(url);
        if (!abs) return '';
        const base = abs.split('#')[0];
        if (sessionPdfZoom === 'fit') {
            return `${base}#toolbar=1&navpanes=0&view=FitH`;
        }
        return `${base}#toolbar=1&navpanes=0&zoom=${sessionPdfZoom}`;
    }

    function buildOfficeOnlineEmbedSrc(url) {
        const abs = sessionPdfAbsoluteUrl(url);
        if (!abs || !/^https:\/\//i.test(abs)) return '';
        return `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(abs)}`;
    }

    function updatePdfZoomLabel() {
        const el = document.getElementById('pdf-zoom-label');
        if (el) el.textContent = sessionPdfZoom === 'fit' ? 'Fit' : `${sessionPdfZoom}%`;
        const page = document.getElementById('session-docx-page');
        if (page) {
            const scale = sessionPdfZoom === 'fit' ? 1 : (sessionPdfZoom / 100);
            page.style.transform = `scale(${scale})`;
        }
    }

    function annotateStorageKey() {
        const doc = state.referencePdf;
        if (!state.currentSession || !doc || !doc.url) return null;
        // v2 = document-anchored coords (scroll with content), not viewport overlay
        return `codemesh_doc_ink_v2_${state.currentSession}_${doc.url}`;
    }

    function loadDocAnnotations() {
        docAnnotate.strokes = [];
        docAnnotate.docKey = annotateStorageKey();
        if (!docAnnotate.docKey) return;
        try {
            const raw = sessionStorage.getItem(docAnnotate.docKey);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) docAnnotate.strokes = parsed;
        } catch (_) { /* ignore */ }
    }

    function persistDocAnnotations() {
        if (!docAnnotate.docKey) return;
        try {
            sessionStorage.setItem(docAnnotate.docKey, JSON.stringify(docAnnotate.strokes));
        } catch (_) { /* quota */ }
    }

    function getAnnotateCanvas() {
        return document.getElementById('doc-annotate-canvas');
    }

    function isDocxAnnotateMode() {
        const wrap = document.getElementById('session-docx-viewer');
        return !!(wrap && !wrap.hidden && state.referencePdf && getReferenceDocKind(state.referencePdf) === 'docx');
    }

    function placeAnnotateCanvas() {
        const canvas = getAnnotateCanvas();
        if (!canvas) return;
        const page = document.getElementById('session-docx-page');
        const stack = document.getElementById('pdf-viewer-stack');
        if (isDocxAnnotateMode() && page) {
            if (canvas.parentElement !== page) page.appendChild(canvas);
            canvas.classList.add('doc-annotate-on-page');
            canvas.classList.remove('doc-annotate-viewport');
            canvas.hidden = false;
        } else if (stack) {
            // PDF/Office iframe: browser handles its own scroll; keep overlay off the iframe
            // so drawings don't fake-stick to the viewport. Pen works on DOCX.
            if (canvas.parentElement !== stack) stack.appendChild(canvas);
            canvas.classList.remove('doc-annotate-on-page');
            canvas.classList.add('doc-annotate-viewport');
            canvas.hidden = true;
        }
    }

    function resizeAnnotateCanvas() {
        const canvas = getAnnotateCanvas();
        if (!canvas) return;
        placeAnnotateCanvas();
        if (canvas.hidden) {
            redrawDocAnnotations();
            return;
        }

        const dpr = window.devicePixelRatio || 1;
        let w;
        let h;
        if (isDocxAnnotateMode()) {
            const content = document.getElementById('session-docx-content');
            const page = document.getElementById('session-docx-page');
            if (!content || !page) return;
            w = Math.max(1, Math.ceil(content.offsetWidth || page.offsetWidth || 1));
            h = Math.max(1, Math.ceil(Math.max(content.scrollHeight, content.offsetHeight, page.offsetHeight) || 1));
            page.style.minHeight = `${h}px`;
        } else {
            const stack = document.getElementById('pdf-viewer-stack');
            if (!stack) return;
            const rect = stack.getBoundingClientRect();
            w = Math.max(1, Math.floor(rect.width));
            h = Math.max(1, Math.floor(rect.height));
        }

        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(h * dpr);
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        redrawDocAnnotations();
    }

    function redrawDocAnnotations() {
        const canvas = getAnnotateCanvas();
        if (!canvas || canvas.hidden) return;
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
        for (const stroke of docAnnotate.strokes) {
            drawStroke(ctx, stroke);
        }
        if (docAnnotate.current) drawStroke(ctx, docAnnotate.current);
    }

    function drawStroke(ctx, stroke) {
        if (!stroke || !stroke.points || stroke.points.length < 1) return;
        ctx.save();
        if (stroke.tool === 'eraser') {
            ctx.globalCompositeOperation = 'destination-out';
            ctx.strokeStyle = 'rgba(0,0,0,1)';
            ctx.lineWidth = stroke.width || 18;
        } else {
            ctx.globalCompositeOperation = 'source-over';
            ctx.strokeStyle = stroke.color || '#111';
            ctx.lineWidth = stroke.width || 2.5;
        }
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        const pts = stroke.points;
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) {
            ctx.lineTo(pts[i].x, pts[i].y);
        }
        if (pts.length === 1) {
            ctx.lineTo(pts[0].x + 0.01, pts[0].y);
        }
        ctx.stroke();
        ctx.restore();
    }

    function canvasPointFromEvent(e) {
        const canvas = getAnnotateCanvas();
        if (!canvas || canvas.hidden) return null;
        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        const dpr = window.devicePixelRatio || 1;
        const logicalW = canvas.width / dpr;
        const logicalH = canvas.height / dpr;
        return {
            x: ((e.clientX - rect.left) / rect.width) * logicalW,
            y: ((e.clientY - rect.top) / rect.height) * logicalH
        };
    }

    function setDocAnnotateTool(tool) {
        const stack = document.getElementById('pdf-viewer-stack');
        const wrap = document.getElementById('session-docx-viewer');
        const hint = document.getElementById('doc-annotate-hint');
        const penBtn = document.getElementById('doc-pen-toggle');
        const eraserBtn = document.getElementById('doc-eraser-toggle');

        placeAnnotateCanvas();
        if (!isDocxAnnotateMode() && tool) {
            showToast('Pen sticks to the page on DOCX. For PDF, use the browser’s built-in pen (open in new tab if needed).', 'info');
            tool = null;
        }

        if (tool && docxEdit.active) {
            docxEdit.active = false;
        }

        if (tool == null) {
            docAnnotate.tool = null;
        } else if (docAnnotate.tool === tool) {
            docAnnotate.tool = null;
        } else {
            docAnnotate.tool = tool;
        }
        stack?.classList.toggle('doc-pen-active', docAnnotate.tool === 'pen');
        stack?.classList.toggle('doc-eraser-active', docAnnotate.tool === 'eraser');
        wrap?.classList.toggle('doc-pen-active', docAnnotate.tool === 'pen');
        wrap?.classList.toggle('doc-eraser-active', docAnnotate.tool === 'eraser');
        penBtn?.classList.toggle('active', docAnnotate.tool === 'pen');
        eraserBtn?.classList.toggle('active', docAnnotate.tool === 'eraser');
        if (hint) {
            if (docAnnotate.tool === 'pen') {
                hint.hidden = false;
                hint.textContent = 'Pen on — marks stay on the page when you scroll. Click pen again to stop.';
            } else if (docAnnotate.tool === 'eraser') {
                hint.hidden = false;
                hint.textContent = 'Eraser on — scrub to erase. Click eraser again to stop.';
            } else {
                hint.hidden = true;
            }
        }
        updateDocxEditToolbar();
        resizeAnnotateCanvas();
    }

    function initDocAnnotate() {
        const canvas = getAnnotateCanvas();
        if (!canvas || canvas.dataset.bound === '1') return;
        canvas.dataset.bound = '1';

        const onDown = (e) => {
            if (!docAnnotate.tool) return;
            e.preventDefault();
            const pt = canvasPointFromEvent(e);
            if (!pt) return;
            try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
            docAnnotate.current = {
                tool: docAnnotate.tool,
                color: docAnnotate.color,
                width: docAnnotate.tool === 'eraser' ? 18 : docAnnotate.width,
                points: [pt]
            };
            redrawDocAnnotations();
        };
        const onMove = (e) => {
            if (!docAnnotate.current) return;
            e.preventDefault();
            const pt = canvasPointFromEvent(e);
            if (!pt) return;
            docAnnotate.current.points.push(pt);
            redrawDocAnnotations();
        };
        const onUp = (e) => {
            if (!docAnnotate.current) return;
            try { canvas.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
            if (docAnnotate.current.points.length) {
                docAnnotate.strokes.push(docAnnotate.current);
                persistDocAnnotations();
            }
            docAnnotate.current = null;
            redrawDocAnnotations();
        };

        canvas.addEventListener('pointerdown', onDown);
        canvas.addEventListener('pointermove', onMove);
        canvas.addEventListener('pointerup', onUp);
        canvas.addEventListener('pointercancel', onUp);

        document.getElementById('doc-pen-toggle')?.addEventListener('click', () => setDocAnnotateTool('pen'));
        document.getElementById('doc-eraser-toggle')?.addEventListener('click', () => setDocAnnotateTool('eraser'));
        document.getElementById('doc-pen-undo')?.addEventListener('click', () => {
            docAnnotate.strokes.pop();
            persistDocAnnotations();
            redrawDocAnnotations();
        });
        document.getElementById('doc-pen-clear')?.addEventListener('click', () => {
            if (!docAnnotate.strokes.length) return;
            if (!confirm('Clear all pen drawings on this document?')) return;
            docAnnotate.strokes = [];
            persistDocAnnotations();
            redrawDocAnnotations();
        });
        document.getElementById('doc-pen-colors')?.addEventListener('click', (e) => {
            const btn = e.target.closest('.doc-pen-swatch');
            if (!btn) return;
            docAnnotate.color = btn.dataset.color || '#111111';
            document.querySelectorAll('.doc-pen-swatch').forEach((el) => {
                el.classList.toggle('active', el === btn);
            });
            if (!docAnnotate.tool) setDocAnnotateTool('pen');
        });

        window.addEventListener('resize', () => {
            if (document.getElementById('editor-layout-split')?.classList.contains('pdf-split-active')) {
                resizeAnnotateCanvas();
            }
        });
    }

    async function loadMammothIfNeeded() {
        if (window.mammoth) return true;
        return new Promise((resolve) => {
            const s = document.createElement('script');
            s.src = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.8.0/mammoth.browser.min.js';
            s.onload = () => resolve(!!window.mammoth);
            s.onerror = () => resolve(false);
            document.head.appendChild(s);
        });
    }

    async function renderDocxInPane(url) {
        const wrap = document.getElementById('session-docx-viewer');
        const content = document.getElementById('session-docx-content');
        const iframe = document.getElementById('session-pdf-viewer');
        if (!wrap || !content) return;
        if (iframe) {
            iframe.style.display = 'none';
            iframe.removeAttribute('src');
        }
        wrap.hidden = false;

        const savedHtml = state.referencePdf && state.referencePdf.editedHtml;
        if (savedHtml) {
            content.innerHTML = savedHtml;
            updatePdfZoomLabel();
            placeAnnotateCanvas();
            requestAnimationFrame(() => {
                resizeAnnotateCanvas();
                updateDocxEditToolbar();
            });
            return;
        }

        content.innerHTML = '<p style="opacity:0.7">Loading Word document…</p>';
        const ok = await loadMammothIfNeeded();
        if (!ok) {
            content.innerHTML = '<p>Could not load DOCX viewer. Open in a new tab instead.</p>';
            return;
        }
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const buffer = await res.arrayBuffer();
            const result = await window.mammoth.convertToHtml({ arrayBuffer: buffer });
            content.innerHTML = result.value || '<p>(Empty document)</p>';
            updatePdfZoomLabel();
            placeAnnotateCanvas();
            requestAnimationFrame(() => {
                resizeAnnotateCanvas();
                content.querySelectorAll('img').forEach((img) => {
                    if (!img.complete) {
                        img.addEventListener('load', () => resizeAnnotateCanvas(), { once: true });
                    }
                });
                updateDocxEditToolbar();
            });
        } catch (err) {
            content.innerHTML = `<p>Failed to render DOCX: ${escapeHtml(err.message || 'unknown error')}</p>`;
        }
    }

    function canEditDocxText() {
        return userCanEditSession()
            && state.referencePdf
            && getReferenceDocKind(state.referencePdf) === 'docx'
            && isDocxAnnotateMode();
    }

    function updateDocxEditToolbar() {
        const editBtn = document.getElementById('doc-text-edit-toggle');
        const saveBtn = document.getElementById('doc-text-save');
        const show = !!(state.referencePdf
            && getReferenceDocKind(state.referencePdf) === 'docx'
            && document.getElementById('session-docx-viewer')
            && !document.getElementById('session-docx-viewer').hidden
            && userCanEditSession());
        if (editBtn) {
            editBtn.style.display = show ? '' : 'none';
            editBtn.classList.toggle('active', !!docxEdit.active);
            editBtn.title = docxEdit.active ? 'Stop editing text' : 'Edit document text';
        }
        if (saveBtn) {
            saveBtn.style.display = show ? '' : 'none';
            saveBtn.disabled = !docxEdit.dirty || docxEdit.saving;
            saveBtn.title = docxEdit.saving ? 'Saving…' : (docxEdit.dirty ? 'Save document text' : 'No changes to save');
        }
        const content = document.getElementById('session-docx-content');
        if (content) {
            const editable = show && docxEdit.active && !docAnnotate.tool;
            content.contentEditable = editable ? 'true' : 'false';
            content.classList.toggle('docx-editing', editable);
            content.spellcheck = editable;
        }
    }

    function setDocxEditMode(force) {
        if (!canEditDocxText() && force !== false) {
            showToast('Only editors can edit this document', 'info');
            return;
        }
        const next = typeof force === 'boolean' ? force : !docxEdit.active;
        if (next && docAnnotate.tool) setDocAnnotateTool(null);
        docxEdit.active = next;
        updateDocxEditToolbar();
        if (docxEdit.active) {
            const content = document.getElementById('session-docx-content');
            content?.focus();
            showToast('Text edit on — click in the document to type. Save when done.', 'info');
        }
        requestAnimationFrame(() => resizeAnnotateCanvas());
    }

    async function saveDocxHtmlEdits() {
        if (!state.currentSession || !state.referencePdf) return;
        if (!userCanEditSession()) {
            showToast('Only editors can save document edits', 'error');
            return;
        }
        const content = document.getElementById('session-docx-content');
        if (!content) return;
        if (!docxEdit.dirty) {
            showToast('No changes to save', 'info');
            return;
        }
        docxEdit.saving = true;
        updateDocxEditToolbar();
        try {
            const data = await api(`/sessions/${state.currentSession}/docx-html`, {
                method: 'PUT',
                body: JSON.stringify({ html: content.innerHTML })
            });
            state.referencePdf = normalizeReferencePdf(data.referencePdf) || state.referencePdf;
            if (state.referencePdf) {
                state.referencePdf.editedHtml = content.innerHTML;
            }
            docxEdit.dirty = false;
            if (state.socket && state.socket.connected) {
                state.socket.emit('session-pdf-updated', {
                    sessionId: state.currentSession,
                    referencePdf: state.referencePdf
                });
            }
            showToast('Document saved', 'success');
            loadDocAnnotations();
            resizeAnnotateCanvas();
        } catch (err) {
            showToast(err.message || 'Failed to save document', 'error');
        } finally {
            docxEdit.saving = false;
            updateDocxEditToolbar();
        }
    }

    function initDocxTextEditing() {
        if (docxEdit.bound) return;
        docxEdit.bound = true;
        const content = document.getElementById('session-docx-content');
        content?.addEventListener('input', () => {
            if (!docxEdit.active) return;
            docxEdit.dirty = true;
            updateDocxEditToolbar();
            resizeAnnotateCanvas();
        });
        content?.addEventListener('keydown', (e) => {
            if (!docxEdit.active) return;
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                e.stopPropagation();
                saveDocxHtmlEdits();
            }
        });
        document.getElementById('doc-text-edit-toggle')?.addEventListener('click', () => setDocxEditMode());
        document.getElementById('doc-text-save')?.addEventListener('click', () => saveDocxHtmlEdits());
    }

    function renderIframeDocument(src) {
        const iframe = document.getElementById('session-pdf-viewer');
        const wrap = document.getElementById('session-docx-viewer');
        if (wrap) {
            wrap.hidden = true;
            const content = document.getElementById('session-docx-content');
            if (content) content.innerHTML = '';
        }
        if (!iframe || !src) return;
        iframe.style.display = 'block';
        iframe.src = src;
    }

    function renderSessionPdf(url) {
        const doc = state.referencePdf || { url };
        const kind = getReferenceDocKind(doc);
        updatePdfZoomLabel();
        loadDocAnnotations();

        if (kind === 'docx') {
            renderDocxInPane(url).then(() => resizeAnnotateCanvas());
            return;
        }
        if (kind === 'doc') {
            const officeSrc = buildOfficeOnlineEmbedSrc(url);
            if (officeSrc) {
                renderIframeDocument(officeSrc);
            } else {
                const wrap = document.getElementById('session-docx-viewer');
                const content = document.getElementById('session-docx-content');
                const iframe = document.getElementById('session-pdf-viewer');
                if (iframe) {
                    iframe.style.display = 'none';
                    iframe.removeAttribute('src');
                }
                if (wrap && content) {
                    wrap.hidden = false;
                    content.innerHTML = '<p>Legacy .doc preview needs HTTPS (or convert to .docx / PDF). Use “Open in new tab” to download.</p>';
                }
            }
            requestAnimationFrame(() => resizeAnnotateCanvas());
            return;
        }
        renderIframeDocument(buildSessionPdfIframeSrc(url));
        requestAnimationFrame(() => resizeAnnotateCanvas());
    }

    function clearSessionPdfView() {
        const iframe = document.getElementById('session-pdf-viewer');
        if (iframe) {
            iframe.removeAttribute('src');
            iframe.style.display = 'block';
        }
        const wrap = document.getElementById('session-docx-viewer');
        const content = document.getElementById('session-docx-content');
        if (wrap) wrap.hidden = true;
        if (content) content.innerHTML = '';
        docAnnotate.strokes = [];
        docAnnotate.current = null;
        docAnnotate.docKey = null;
        docxEdit.active = false;
        docxEdit.dirty = false;
        docxEdit.saving = false;
        if (docAnnotate.tool) setDocAnnotateTool(null);
        updateDocxEditToolbar();
        redrawDocAnnotations();
    }

    function openSessionPdfInNewTab() {
        const url = state.referencePdf && state.referencePdf.url;
        if (!url) return;
        window.open(sessionPdfAbsoluteUrl(url), '_blank', 'noopener');
    }

    function setSessionPdfZoom(next) {
        if (next === 'fit') {
            sessionPdfZoom = 'fit';
        } else {
            sessionPdfZoom = Math.max(50, Math.min(300, Math.round(next)));
        }
        updatePdfZoomLabel();
        if (state.referencePdf && state.referencePdf.url) {
            const kind = getReferenceDocKind(state.referencePdf);
            if (kind === 'pdf') {
                renderSessionPdf(state.referencePdf.url);
            } else {
                resizeAnnotateCanvas();
            }
        }
    }

    let publishBlobUrl = null;
    let currentClashSlug = null;
    let clashPollInterval = null;
    let clashTickInterval = null;
    let clashLobbyTickInterval = null;
    let clashMonacoEditor = null;
    let clashSandboxLangsCache = null;

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
            const partsH = rawH.split('/').filter(Boolean).map(decodeUrlPathSegment);
            if (partsH.length === 0) return { mode: 'clash-hub' };
            if (partsH.length >= 2 && partsH[0].toLowerCase() === 'c') {
                return { mode: 'clash-room', clashSlug: partsH[1] };
            }
            return { mode: 'clash-room', clashSlug: partsH[0] };
        }

        const raw = window.location.pathname.replace(/^\/+|\/+$/g, '');
        if (!raw) return null;
        const parts = raw.split('/').filter(Boolean).map(decodeUrlPathSegment);
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
            if (isValidSessionIdClient(first)) return { sessionId: first, mode: 'editor' };
            return null;
        }
        if (parts.length === 2) {
            const sid = first;
            const sub = parts[1].toLowerCase();
            if (!isValidSessionIdClient(sid)) return null;
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
                const canon = sessionEditorPath(sessionId) + '/' + seg;
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
            const canon = sessionEditorPath(sessionId) + '/' + seg;
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

    function userCanEditSession() {
        return state.userRole === 'owner' || state.userRole === 'editor' || state.userRole === 'admin';
    }

    function userCanCopySessionCode() {
        if (state.userRole === 'owner' || state.userRole === 'admin') return true;
        return !!state.allowCollaboratorCopy;
    }

    function copyBlockedMessage() {
        return state.allowCollaboratorCopy
            ? 'Copying is not allowed for your role'
            : 'Copying is disabled for guests in this session';
    }

    let sessionCopyProtectionAbort = null;

    function setSessionCopyProtection(enabled) {
        const primaryPane = document.getElementById('editor-split-pane-primary');
        primaryPane?.classList.toggle('session-no-copy', enabled);

        if (sessionCopyProtectionAbort) {
            sessionCopyProtectionAbort.abort();
            sessionCopyProtectionAbort = null;
        }
        if (!enabled) return;

        const ac = new AbortController();
        sessionCopyProtectionAbort = ac;
        const opts = { capture: true, signal: ac.signal };
        const targets = [
            document.getElementById('editor-container'),
            primaryPane
        ].filter(Boolean);

        const blockClipboard = (e) => {
            if (userCanCopySessionCode()) return;
            e.preventDefault();
            e.stopPropagation();
            showToast(copyBlockedMessage(), 'info');
        };

        const blockSelection = (e) => {
            if (userCanCopySessionCode()) return;
            e.preventDefault();
        };

        for (const el of targets) {
            el.addEventListener('copy', blockClipboard, opts);
            el.addEventListener('cut', blockClipboard, opts);
            el.addEventListener('selectstart', blockSelection, opts);
            el.addEventListener('contextmenu', (e) => {
                if (userCanCopySessionCode()) return;
                e.preventDefault();
            }, opts);
            el.addEventListener('dragstart', (e) => {
                if (userCanCopySessionCode()) return;
                e.preventDefault();
            }, opts);
        }

        document.addEventListener('keydown', (e) => {
            if (userCanCopySessionCode()) return;
            if (state.focusedPane !== 'primary') return;
            const mod = e.ctrlKey || e.metaKey;
            if (!mod) return;
            const key = e.key.toLowerCase();
            if (key === 'c' || key === 'x' || key === 'a') {
                e.preventDefault();
                e.stopPropagation();
                if (key === 'c' || key === 'x') {
                    showToast(copyBlockedMessage(), 'info');
                }
            }
        }, opts);
    }

    function attachSessionEditorCopyGuards(editor, fileId) {
        if (!editor || fileId === SPLIT_SCRATCH_ID) return;
        editor.onKeyDown((e) => {
            if (userCanCopySessionCode()) return;
            const mod = e.ctrlKey || e.metaKey;
            if (!mod) return;
            const k = e.keyCode;
            if (k === monaco.KeyCode.KeyC || k === monaco.KeyCode.KeyX || k === monaco.KeyCode.KeyA) {
                e.preventDefault();
                e.stopPropagation();
                if (k === monaco.KeyCode.KeyC || k === monaco.KeyCode.KeyX) {
                    showToast(copyBlockedMessage(), 'info');
                }
            }
        });
    }

    function collapseSessionSelection(editor, fileId) {
        if (!editor || fileId === SPLIT_SCRATCH_ID || userCanCopySessionCode()) return;
        const selection = editor.getSelection();
        if (!selection || selection.isEmpty()) return;
        const pos = selection.getPosition();
        editor.setSelection(monaco.Selection.fromPositions(pos, pos));
    }

    function updateSessionCopyRestrictions() {
        const restricted = !userCanCopySessionCode();
        setSessionCopyProtection(restricted);
        updateCopyRestrictedUI();
        const canCopySession = userCanCopySessionCode();
        if (state.editorView) {
            state.editorView.updateOptions({
                selectionClipboard: canCopySession,
                selectionHighlight: canCopySession
            });
        }
        if (state.splitEditor) {
            state.splitEditor.updateOptions({
                selectionClipboard: true,
                selectionHighlight: true
            });
        }
        if (state.editorView && state.activeFileId) {
            collapseSessionSelection(state.editorView, state.activeFileId);
        }
    }

    function updateCopyRestrictedUI() {
        const canCopySession = userCanCopySessionCode();
        document.getElementById('download-active-file-btn')?.style.setProperty('display', canCopySession ? '' : 'none');
        document.getElementById('split-pane-download-btn')?.style.setProperty(
            'display',
            canCopySession || state.userRole === 'editor' ? '' : 'none'
        );
    }

    function fileDocFromPayload(fileData) {
        if (!fileData) return '';
        if (fileData.doc != null && String(fileData.doc).length > 0) return String(fileData.doc);
        if (fileData.content != null) return String(fileData.content);
        return '';
    }

    function layoutMonacoEditor() {
        layoutMonacoEditors();
    }

    function layoutMonacoEditors() {
        requestAnimationFrame(() => {
            try { state.editorView?.layout(); } catch (_) { /* ignore */ }
            try { state.splitEditor?.layout(); } catch (_) { /* ignore */ }
        });
    }

    const PANE_RESIZER_KEYS = {
        pdfCode: 'codemesh_pdf_pane_ratio',
        editorSplit: 'codemesh_editor_split_ratio'
    };

    let pdfCodeResizer = null;
    let editorSplitResizer = null;

    function resetPaneFlexStyles(pane) {
        if (!pane) return;
        pane.style.flex = '';
        pane.style.width = '';
        pane.style.maxWidth = '';
        pane.style.minWidth = '';
    }

    function createHorizontalPaneResizer(options) {
        const {
            splitter,
            container,
            primaryPane,
            secondaryPane,
            storageKey,
            defaultRatio = 0.5,
            minRatio = 0.12,
            maxRatio = 0.88,
            autoApply = true
        } = options;
        if (!splitter || !container || !primaryPane || !secondaryPane) return null;
        if (splitter.dataset.bound === '1') {
            return { apply: splitter._paneApply, reapply: splitter._paneReapply };
        }

        let ratio = defaultRatio;
        try {
            const saved = parseFloat(sessionStorage.getItem(storageKey));
            if (Number.isFinite(saved) && saved >= minRatio && saved <= maxRatio) ratio = saved;
        } catch (_) { /* ignore */ }

        const apply = (nextRatio) => {
            ratio = Math.max(minRatio, Math.min(maxRatio, nextRatio));
            const pct = `${(ratio * 100).toFixed(2)}%`;
            primaryPane.style.flex = `0 0 ${pct}`;
            primaryPane.style.width = pct;
            primaryPane.style.maxWidth = 'none';
            secondaryPane.style.flex = '1 1 0';
            secondaryPane.style.minWidth = '0';
            try { sessionStorage.setItem(storageKey, String(ratio)); } catch (_) { /* quota */ }
        };

        const reapply = () => apply(ratio);

        splitter._paneApply = apply;
        splitter._paneReapply = reapply;
        splitter.dataset.bound = '1';

        const onPointerDown = (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            try { splitter.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
            splitter.classList.add('pane-splitter-dragging');
            document.body.classList.add('pane-resize-active');

            const onPointerMove = (ev) => {
                const rect = container.getBoundingClientRect();
                if (rect.width <= 0) return;
                apply((ev.clientX - rect.left) / rect.width);
            };
            const onPointerUp = (ev) => {
                try { splitter.releasePointerCapture(ev.pointerId); } catch (_) { /* ignore */ }
                splitter.classList.remove('pane-splitter-dragging');
                document.body.classList.remove('pane-resize-active');
                splitter.removeEventListener('pointermove', onPointerMove);
                splitter.removeEventListener('pointerup', onPointerUp);
                splitter.removeEventListener('pointercancel', onPointerUp);
                layoutMonacoEditors();
            };
            splitter.addEventListener('pointermove', onPointerMove);
            splitter.addEventListener('pointerup', onPointerUp);
            splitter.addEventListener('pointercancel', onPointerUp);
            onPointerMove(e);
        };

        splitter.addEventListener('pointerdown', onPointerDown);

        splitter.addEventListener('dblclick', (e) => {
            e.preventDefault();
            apply(defaultRatio);
            layoutMonacoEditors();
        });

        if (autoApply) apply(ratio);
        return { apply, reapply };
    }

    function initPaneResizers() {
        const pdfSplitter = document.getElementById('pdf-code-splitter');
        const editorLayout = document.getElementById('editor-layout-split');
        const pdfPane = document.getElementById('pdf-split-pane');
        const codePane = document.getElementById('editor-code-pane');
        if (pdfSplitter && editorLayout && pdfPane && codePane) {
            pdfCodeResizer = createHorizontalPaneResizer({
                splitter: pdfSplitter,
                container: editorLayout,
                primaryPane: pdfPane,
                secondaryPane: codePane,
                storageKey: PANE_RESIZER_KEYS.pdfCode,
                defaultRatio: 0.38,
                minRatio: 0.15,
                maxRatio: 0.75,
                autoApply: false
            });
        }

        const editorSplitter = document.getElementById('editor-code-split-splitter');
        const splitContainer = document.getElementById('editor-split-container');
        const primaryPane = document.getElementById('editor-split-pane-primary');
        const secondaryPane = document.getElementById('editor-split-pane-secondary');
        if (editorSplitter && splitContainer && primaryPane && secondaryPane) {
            editorSplitResizer = createHorizontalPaneResizer({
                splitter: editorSplitter,
                container: splitContainer,
                primaryPane,
                secondaryPane,
                storageKey: PANE_RESIZER_KEYS.editorSplit,
                defaultRatio: 0.5,
                minRatio: 0.2,
                maxRatio: 0.8,
                autoApply: false
            });
        }
    }

    function ensurePaneResizers() {
        if (!pdfCodeResizer || !editorSplitResizer) initPaneResizers();
    }

    function syncPdfCodeSplitterVisibility() {
        if (pdfCodeResizer) pdfCodeResizer.reapply();
    }

    function syncEditorCodeSplitterVisibility() {
        if (state.splitActive && editorSplitResizer) editorSplitResizer.reapply();
    }

    function syncFileDocFromEditor(fileId, editor) {
        if (!fileId || !editor) return;
        const file = state.files.get(fileId);
        if (file) file.doc = editor.getValue();
    }

    function syncAllOpenEditorsToFiles() {
        if (state.activeFileId && state.editorView) {
            syncFileDocFromEditor(state.activeFileId, state.editorView);
        }
        if (state.splitActive && state.splitEditor) {
            state.splitScratch.doc = state.splitEditor.getValue();
        }
    }

    function extensionForLang(lang) {
        return EXT_FOR_LANG[lang] || '.txt';
    }

    function getActiveFileStem() {
        const file = state.activeFileId && state.files.get(state.activeFileId);
        if (!file) return 'untitled';
        const base = fileBasename(file.name);
        const dot = base.lastIndexOf('.');
        return dot > 0 ? base.slice(0, dot) : base;
    }

    function getSplitScratchDisplayName() {
        const stem = state.splitScratch.sourceStem || getActiveFileStem();
        return stem + extensionForLang(state.splitScratch.language);
    }

    function defaultSplitLanguageForLeft() {
        const file = state.activeFileId && state.files.get(state.activeFileId);
        const left = file ? resolveEditorLanguage(file, file.doc) : 'plaintext';
        const prefer = ['python', 'cpp', 'java', 'javascript'];
        for (const lang of prefer) {
            if (lang !== left) return lang;
        }
        return left === 'python' ? 'cpp' : 'python';
    }

    function syncSplitScratchFromLeft() {
        state.splitScratch.sourceStem = getActiveFileStem();
        updateSplitPaneUI();
    }

    function updateSplitPaneUI() {
        const nameEl = document.getElementById('split-pane-filename');
        if (nameEl) {
            nameEl.textContent = getSplitScratchDisplayName();
            nameEl.title = `Synced from left file: ${getActiveFileStem()}${extensionForLang(state.splitScratch.language)}`;
        }
        const langSel = document.getElementById('split-pane-lang-select');
        if (langSel && langSel.value !== state.splitScratch.language) {
            langSel.value = state.splitScratch.language;
        }
    }

    function populateSplitLangSelect() {
        const sel = document.getElementById('split-pane-lang-select');
        if (!sel || sel.options.length > 0) return;
        sel.innerHTML = SPLIT_LANG_OPTIONS.map(([value, label]) =>
            `<option value="${value}">${escapeHtml(label)}</option>`
        ).join('');
    }

    function persistSplitScratch() {
        if (!state.currentSession) return;
        try {
            sessionStorage.setItem(`codemesh_split_scratch_${state.currentSession}`, JSON.stringify({
                language: state.splitScratch.language,
                doc: state.splitScratch.doc,
                sourceStem: state.splitScratch.sourceStem
            }));
        } catch (_) { /* quota */ }
    }

    function restoreSplitScratch() {
        if (!state.currentSession) return;
        try {
            const raw = sessionStorage.getItem(`codemesh_split_scratch_${state.currentSession}`);
            if (!raw) return;
            const data = JSON.parse(raw);
            if (data.language) state.splitScratch.language = data.language;
            if (data.doc != null) state.splitScratch.doc = String(data.doc);
            if (data.sourceStem) state.splitScratch.sourceStem = data.sourceStem;
        } catch (_) { /* ignore */ }
    }

    function setSplitScratchLanguage(lang, updateEditor) {
        state.splitScratch.language = lang;
        updateSplitPaneUI();
        if (updateEditor && state.splitEditor && monacoLoaded) {
            monaco.editor.setModelLanguage(state.splitEditor.getModel(), mapLanguageToMonaco(lang));
        }
        if (state.focusedPane === 'split') {
            updateStatusbarLanguage(lang);
            if (state.splitEditor) updateStdinHintForCode(state.splitEditor.getValue(), 'split');
        }
        persistSplitScratch();
    }

    function getFocusedFileId() {
        if (state.splitActive && state.focusedPane === 'split') {
            return SPLIT_SCRATCH_ID;
        }
        return state.activeFileId;
    }

    function getFocusedEditor() {
        if (state.splitActive && state.focusedPane === 'split' && state.splitEditor) {
            return state.splitEditor;
        }
        return state.editorView;
    }

    function getEditorForFileId(fileId) {
        if (fileId === SPLIT_SCRATCH_ID && state.splitActive) return state.splitEditor;
        if (fileId === state.activeFileId) return state.editorView;
        return null;
    }

    function updateSplitPaneFocusStyles() {
        const primary = document.getElementById('editor-split-pane-primary');
        const secondary = document.getElementById('editor-split-pane-secondary');
        primary?.classList.toggle('focused-pane', state.focusedPane === 'primary');
        secondary?.classList.toggle('focused-pane', state.splitActive && state.focusedPane === 'split');
    }

    function updateSplitLayout() {
        const splitContainer = document.getElementById('editor-split-container');
        const pane2 = document.getElementById('editor-split-pane-secondary');
        const pane1 = document.getElementById('editor-split-pane-primary');
        if (splitContainer) splitContainer.classList.toggle('split-active', state.splitActive);
        if (pane2) pane2.style.display = state.splitActive ? 'flex' : 'none';
        syncEditorCodeSplitterVisibility();
        if (state.splitActive && editorSplitResizer) {
            editorSplitResizer.reapply();
        } else if (!state.splitActive) {
            resetPaneFlexStyles(pane1);
            resetPaneFlexStyles(pane2);
        }
        populateSplitLangSelect();
        updateSplitPaneUI();
        updateSplitPaneFocusStyles();
    }

    function mountEditorInContainer(container, fileId) {
        const file = state.files.get(fileId);
        if (!file || !container) return null;
        container.innerHTML = '';
        const lang = resolveEditorLanguage(file, file.doc);
        return createEditor(container, file.doc, lang, fileId);
    }

    function mountSplitEditor() {
        if (!state.splitActive) return;
        syncSplitScratchFromLeft();
        const container2 = document.getElementById('editor-container-2');
        if (!container2) return;
        if (state.splitEditor) {
            state.splitScratch.doc = state.splitEditor.getValue();
            state.splitEditor.dispose();
            state.splitEditor = null;
        }
        container2.innerHTML = '';
        const lang = state.splitScratch.language;
        state.splitEditor = createEditor(container2, state.splitScratch.doc || '', lang, SPLIT_SCRATCH_ID);
        if (state.splitEditor) {
            state.splitEditor.onDidFocusEditorWidget(() => {
                state.focusedPane = 'split';
                updateStatusbarLanguage(state.splitScratch.language);
                updateStdinHintForCode(state.splitEditor.getValue(), 'split');
                updateSplitPaneFocusStyles();
            });
            if (state.userRole === 'viewer') {
                state.splitEditor.updateOptions({ readOnly: true });
            }
        }
        layoutMonacoEditors();
    }

    function enableEditorSplit() {
        if (!state.editorView) return false;
        populateSplitLangSelect();
        if (!state.splitScratch.language) {
            state.splitScratch.language = defaultSplitLanguageForLeft();
        }
        state.splitActive = true;
        syncSplitScratchFromLeft();
        updateSplitLayout();
        mountSplitEditor();
        restoreSplitStdin();
        return true;
    }

    function disableEditorSplit() {
        if (state.splitEditor) {
            state.splitScratch.doc = state.splitEditor.getValue();
            persistSplitScratch();
            state.splitEditor.dispose();
            state.splitEditor = null;
        }
        state.splitActive = false;
        state.focusedPane = 'primary';
        const container2 = document.getElementById('editor-container-2');
        if (container2) container2.innerHTML = '';
        updateSplitLayout();
    }

    function getSplitStdin() {
        const el = document.getElementById('run-stdin-split-input');
        return el ? el.value : '';
    }

    function persistSplitStdin() {
        if (!state.currentSession) return;
        try {
            sessionStorage.setItem(`codemesh_stdin_split_${state.currentSession}`, getSplitStdin());
        } catch (_) { /* quota */ }
        if (state.splitEditor) updateStdinHintForCode(state.splitEditor.getValue(), 'split');
    }

    function restoreSplitStdin() {
        const el = document.getElementById('run-stdin-split-input');
        if (!el || !state.currentSession) return;
        try {
            const saved = sessionStorage.getItem(`codemesh_stdin_split_${state.currentSession}`);
            if (saved != null) el.value = saved;
        } catch (_) { /* ignore */ }
    }

    function hydrateFilesFromSessionPayload(sessionData) {
        const list = sessionData && sessionData.files;
        if (!Array.isArray(list) || !list.length) return null;

        state.files.clear();
        state.openTabs.clear();
        state.tabOrder = [];
        let firstFileId = null;
        for (const f of list) {
            if (!f || !f.id) continue;
            const doc = fileDocFromPayload(f);
            const lang = resolveEditorLanguage({
                name: f.name,
                language: f.language,
                doc
            });
            state.files.set(f.id, {
                id: f.id,
                name: f.name,
                doc,
                language: lang,
                version: 0
            });
            if (!firstFileId) firstFileId = f.id;
        }
        return firstFileId;
    }

    function userCanManageSessionSettings() {
        if (state.userRole === 'owner' || state.userRole === 'admin') return true;
        if (state.user && state.user.role === 'admin') return true;
        const uid = state.user && (state.user.id || state.user._id);
        return !!(state.sessionOwnerId && uid && state.sessionOwnerId.toString() === uid.toString());
    }

    function userCanViewSessionCode() {
        if (state.userRole === 'owner' || state.userRole === 'admin') return true;
        if (state.user && state.user.role === 'admin') return true;
        if (state.codeHiddenFromGuest) return false;
        if (!state.guestCodeVisibleUntil) return true;
        return Date.now() < new Date(state.guestCodeVisibleUntil).getTime();
    }

    function formatVisibilityRemaining(ms) {
        if (!Number.isFinite(ms) || ms <= 0) return 'Expired';
        const totalSec = Math.ceil(ms / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        if (h > 0) return `${h}h ${m}m left`;
        if (m > 0) return `${m}m ${s}s left`;
        return `${s}s left`;
    }

    function stopCodeVisibilityCountdown() {
        if (state.codeVisibilityCountdownTimer) {
            clearInterval(state.codeVisibilityCountdownTimer);
            state.codeVisibilityCountdownTimer = null;
        }
    }

    function refreshGuestCodeVisibilityStatus() {
        if (!state.guestCodeVisibleUntil) {
            state.guestCodeVisibility = { status: 'forever', expiresAt: null, remainingMs: null };
            return;
        }
        const expiresAt = new Date(state.guestCodeVisibleUntil);
        const remainingMs = expiresAt.getTime() - Date.now();
        if (remainingMs > 0) {
            state.guestCodeVisibility = { status: 'visible', expiresAt, remainingMs };
        } else {
            state.guestCodeVisibility = { status: 'hidden', expiresAt, remainingMs: 0 };
        }
    }

    function startCodeVisibilityCountdown() {
        stopCodeVisibilityCountdown();
        refreshGuestCodeVisibilityStatus();
        updateCodeVisibilityUI();
        if (!state.guestCodeVisibleUntil) return;

        state.codeVisibilityCountdownTimer = setInterval(() => {
            const wasVisible = userCanViewSessionCode();
            refreshGuestCodeVisibilityStatus();
            updateCodeVisibilityUI();
            updateCodeRestrictedUI();

            const nowVisible = userCanViewSessionCode();
            if (wasVisible && !nowVisible && !userCanManageSessionSettings()) {
                state.codeHiddenFromGuest = true;
                applyGuestCodeHiddenState(true);
                showToast('Guest code viewing has ended — files are still here, but contents are restricted', 'info');
            }
        }, 1000);
    }

    function getRestrictedFileSummary() {
        const files = Array.from(state.files.values());
        if (!files.length) return 'This session has workspace files, but their contents are hidden.';
        const names = files.map((f) => f.name).slice(0, 6);
        const extra = files.length > names.length ? ` (+${files.length - names.length} more)` : '';
        return `Files in this session: ${names.join(', ')}${extra}`;
    }

    function updateCodeRestrictedUI() {
        const bar = document.getElementById('code-restricted-bar');
        const barText = document.getElementById('code-restricted-bar-text');
        const placeholder = document.getElementById('code-restricted-placeholder');
        const summary = document.getElementById('code-restricted-file-summary');
        const container = document.getElementById('editor-container');
        const primaryPane = document.getElementById('editor-split-pane-primary');
        if (!bar || !placeholder || !container || !primaryPane) return;

        refreshGuestCodeVisibilityStatus();
        const vis = state.guestCodeVisibility || { status: 'forever' };
        const guestViewBlocked = vis.status === 'hidden';
        const canView = userCanViewSessionCode();
        const isOwner = userCanManageSessionSettings();

        if (!guestViewBlocked && canView) {
            bar.style.display = 'none';
            placeholder.style.display = 'none';
            placeholder.setAttribute('aria-hidden', 'true');
            container.style.display = '';
            primaryPane.classList.remove('code-view-restricted');
            bar.classList.remove('code-restricted-bar--owner');
            return;
        }

        bar.style.display = '';
        if (isOwner) {
            bar.classList.add('code-restricted-bar--owner');
            if (barText) {
                barText.textContent = guestViewBlocked
                    ? 'Guests cannot view code right now. You still have full access as owner/admin.'
                    : `Guest view timer active — ${formatVisibilityRemaining(vis.remainingMs)} remaining for guests.`;
            }
            placeholder.style.display = 'none';
            placeholder.setAttribute('aria-hidden', 'true');
            container.style.display = '';
            primaryPane.classList.remove('code-view-restricted');
            return;
        }

        bar.classList.remove('code-restricted-bar--owner');
        if (barText) {
            barText.textContent = 'This session has code, but guest viewing is currently restricted.';
        }
        placeholder.style.display = '';
        placeholder.setAttribute('aria-hidden', 'false');
        primaryPane.classList.add('code-view-restricted');
        if (summary) summary.textContent = getRestrictedFileSummary();

        if (state.editorView) {
            state.editorView.dispose();
            state.editorView = null;
        }
    }

    function applyGuestCodeHiddenState(hidden) {
        if (!hidden) {
            updateCodeRestrictedUI();
            if (state.activeFileId && state.files.has(state.activeFileId) && userCanViewSessionCode()) {
                openFileInPrimary(state.activeFileId);
            }
            return;
        }

        if (!userCanManageSessionSettings()) {
            for (const file of state.files.values()) {
                file.doc = '';
            }
        }
        updateCodeRestrictedUI();
        renderFileTree();
        renderTabs();
        setEditorReadOnly(true);
    }

    function updateCodeVisibilityUI() {
        const wrap = document.getElementById('code-visibility-wrap');
        const toggle = document.getElementById('code-visibility-toggle');
        const controls = document.getElementById('code-visibility-controls');
        const statusEl = document.getElementById('code-visibility-status');
        const foreverBtn = document.getElementById('code-visibility-forever-btn');
        const restoreBtn = document.getElementById('code-visibility-restore-btn');
        if (!wrap || !toggle) return;

        const canManage = userCanManageSessionSettings();
        wrap.style.display = canManage ? '' : 'none';
        if (!canManage) return;

        refreshGuestCodeVisibilityStatus();
        const vis = state.guestCodeVisibility || { status: 'forever' };
        const timerEnabled = vis.status === 'visible';

        toggle.checked = timerEnabled;
        if (controls) controls.style.display = timerEnabled ? '' : 'none';

        if (foreverBtn) {
            foreverBtn.style.display = state.guestCodeVisibleUntil ? '' : 'none';
        }
        if (restoreBtn) {
            restoreBtn.style.display = vis.status === 'hidden' ? '' : 'none';
        }
        if (statusEl) {
            if (vis.status === 'forever') statusEl.textContent = 'Forever (default)';
            else if (vis.status === 'visible') statusEl.textContent = formatVisibilityRemaining(vis.remainingMs);
            else statusEl.textContent = 'Hidden from guests';
        }
    }

    async function updateGuestCodeVisibility(mode, durationMinutes) {
        if (!state.currentSession || !userCanManageSessionSettings()) return;

        try {
            const payload = { mode };
            if (mode === 'timed') payload.durationMinutes = durationMinutes;

            if (state.socket && state.socket.connected) {
                state.socket.emit('set-code-visibility', {
                    sessionId: state.currentSession,
                    ...payload
                });
            } else {
                await api(`/sessions/${state.currentSession}/code-visibility`, {
                    method: 'PUT',
                    body: JSON.stringify(payload)
                });
            }

            if (mode === 'forever' || mode === 'restore') {
                state.guestCodeVisibleUntil = null;
                state.codeHiddenFromGuest = false;
            } else if (mode === 'timed') {
                state.guestCodeVisibleUntil = new Date(Date.now() + durationMinutes * 60 * 1000).toISOString();
                state.codeHiddenFromGuest = false;
            }
            refreshGuestCodeVisibilityStatus();
            startCodeVisibilityCountdown();
            updateCodeRestrictedUI();

            const messages = {
                forever: 'Guest code visibility set to forever',
                restore: 'Code is visible to guests again',
                timed: `Guests can view code for ${durationMinutes} minute${durationMinutes === 1 ? '' : 's'}`
            };
            showToast(messages[mode] || 'Code visibility updated', 'success');
        } catch (err) {
            showToast(err.message || 'Failed to update code visibility', 'error');
        }
    }

    function getSelectedVisibilityMinutes() {
        const sel = document.getElementById('code-visibility-duration');
        const custom = document.getElementById('code-visibility-custom-minutes');
        if (!sel) return null;
        if (sel.value === 'custom') {
            const minutes = Number(custom && custom.value);
            if (!Number.isFinite(minutes) || minutes <= 0) return null;
            return Math.min(525600, Math.floor(minutes));
        }
        return Number(sel.value);
    }

    function applyCodeVisibilityMeta(meta) {
        if (!meta) return;
        if (meta.guestCodeVisibleUntil !== undefined) {
            state.guestCodeVisibleUntil = meta.guestCodeVisibleUntil;
        }
        if (meta.guestCodeVisibility) {
            state.guestCodeVisibility = meta.guestCodeVisibility;
        }
        if (meta.codeHiddenFromGuest !== undefined) {
            state.codeHiddenFromGuest = !!meta.codeHiddenFromGuest;
        }
        refreshGuestCodeVisibilityStatus();
        startCodeVisibilityCountdown();
        updateCodeVisibilityUI();
        if (!userCanViewSessionCode() && !userCanManageSessionSettings()) {
            applyGuestCodeHiddenState(true);
        } else {
            updateCodeRestrictedUI();
        }
    }

    function handleCodeVisibilityChanged(data) {
        if (!data) return;
        const prevCanView = userCanViewSessionCode();
        applyCodeVisibilityMeta({
            guestCodeVisibleUntil: data.guestCodeVisibleUntil,
            guestCodeVisibility: data.guestCodeVisibility,
            codeHiddenFromGuest: data.guestCodeVisibility && data.guestCodeVisibility.status === 'hidden'
        });

        const nowCanView = userCanViewSessionCode();
        if (!prevCanView && nowCanView && !userCanManageSessionSettings()) {
            if (state.socket && state.currentSession) {
                state.socket.emit('request-state', { sessionId: state.currentSession });
            }
            showToast('Code is visible again', 'info');
        } else if (prevCanView && !nowCanView && !userCanManageSessionSettings()) {
            showToast('Code is no longer visible for guests', 'info');
        }
    }

    function getDashboardClassKey() {
        const el = document.getElementById('join-class-key-input');
        return el ? el.value.trim() : '';
    }

    function promptClassKeyModal(sessionId) {
        return new Promise((resolve) => {
            const modal = document.getElementById('class-key-modal');
            const input = document.getElementById('class-key-modal-input');
            const submit = document.getElementById('class-key-modal-submit');
            const cancel = document.getElementById('class-key-modal-cancel');
            const backdrop = document.getElementById('class-key-modal-backdrop');
            if (!modal || !input || !submit) {
                resolve(null);
                return;
            }

            modal.dataset.sessionId = sessionId;
            input.value = '';
            modal.style.display = 'flex';
            modal.setAttribute('aria-hidden', 'false');
            input.focus();

            const cleanup = () => {
                submit.removeEventListener('click', onSubmit);
                cancel?.removeEventListener('click', onCancel);
                backdrop?.removeEventListener('click', onCancel);
                input.removeEventListener('keydown', onKey);
            };

            const close = (value) => {
                modal.style.display = 'none';
                modal.setAttribute('aria-hidden', 'true');
                cleanup();
                resolve(value);
            };

            const onSubmit = () => {
                const key = input.value.trim();
                if (!key) {
                    showToast('Enter the class key', 'error');
                    return;
                }
                close(key);
            };

            const onCancel = () => close(null);
            const onKey = (e) => {
                if (e.key === 'Enter') { e.preventDefault(); onSubmit(); }
                if (e.key === 'Escape') onCancel();
            };

            submit.addEventListener('click', onSubmit);
            cancel?.addEventListener('click', onCancel);
            backdrop?.addEventListener('click', onCancel);
            input.addEventListener('keydown', onKey);
        });
    }

    async function joinOrOpenSession(sessionId, classKey) {
        const body = { sessionId, title: sessionId };
        if (classKey) body.classKey = classKey;
        return api('/sessions/join-or-create', {
            method: 'POST',
            body: JSON.stringify(body)
        });
    }

    async function openEditorWithAccess(sessionId, classKey) {
        let sessionData;
        try {
            sessionData = await joinOrOpenSession(sessionId, classKey);
            if (classKey) state.pendingClassKey = classKey;
        } catch (err) {
            if (err.code === 'CLASS_KEY_REQUIRED' || err.code === 'CLASS_KEY_INVALID') {
                if (err.code === 'CLASS_KEY_INVALID') {
                    showToast('Invalid class key — try again', 'error');
                }
                const key = await promptClassKeyModal(sessionId);
                if (!key) {
                    const e = new Error('Join cancelled');
                    e.cancelled = true;
                    throw e;
                }
                try {
                    sessionData = await joinOrOpenSession(sessionId, key);
                    state.pendingClassKey = key;
                } catch (err2) {
                    if (err2.code === 'CLASS_KEY_INVALID') {
                        showToast('Invalid class key', 'error');
                        return openEditorWithAccess(sessionId, null);
                    }
                    throw err2;
                }
            } else {
                throw err;
            }
        }
        return sessionData;
    }

    function updateSessionAccessUI() {
        const wrap = document.getElementById('session-access-wrap');
        const sel = document.getElementById('session-access-select');
        const keyInput = document.getElementById('session-class-key-input');
        if (!wrap || !sel) return;

        const show = userCanManageSessionSettings();
        wrap.style.display = show ? '' : 'none';
        if (!show) return;

        const isPublic = state.sessionIsPublic !== false;
        sel.value = isPublic ? 'public' : 'private';
        if (keyInput) {
            keyInput.style.display = isPublic ? 'none' : '';
            keyInput.value = '';
            keyInput.placeholder = state.sessionHasClassKey
                ? 'New class key (optional)'
                : 'Class key (required)';
        }
    }

    function syncSessionAccessModalFields() {
        const sel = document.getElementById('session-access-modal-select');
        const keyInput = document.getElementById('session-access-modal-key');
        const keyGroup = document.getElementById('session-access-modal-key-group');
        const hint = document.getElementById('session-access-modal-key-hint');
        if (!sel) return;

        const isPublic = state.sessionIsPublic !== false;
        sel.value = isPublic ? 'public' : 'private';
        if (keyGroup) keyGroup.style.display = isPublic ? 'none' : '';
        if (keyInput) {
            keyInput.value = '';
            keyInput.placeholder = state.sessionHasClassKey
                ? 'New class key (leave blank to keep current)'
                : '4–64 characters';
        }
        if (hint) {
            hint.textContent = state.sessionHasClassKey
                ? 'A class key is already set. Enter a new one only if you want to change it.'
                : 'Students will need this key to join when the session is private.';
        }
    }

    function closeSessionAccessModal() {
        const modal = document.getElementById('session-access-modal');
        if (!modal) return;
        modal.style.display = 'none';
        modal.setAttribute('aria-hidden', 'true');
    }

    function openSessionAccessModal() {
        if (!state.currentSession) {
            showToast('Open a session first', 'error');
            return;
        }
        if (!userCanManageSessionSettings()) {
            showToast('Only the session owner or site admin can change access', 'error');
            return;
        }
        const modal = document.getElementById('session-access-modal');
        if (!modal) return;
        syncSessionAccessModalFields();
        modal.style.display = 'flex';
        modal.setAttribute('aria-hidden', 'false');
        document.getElementById('session-access-modal-key')?.focus();
    }

    async function saveSessionAccessSettings(fromModal) {
        if (!state.currentSession || !userCanManageSessionSettings()) return;

        let isPublic;
        let classKey = '';
        if (fromModal) {
            const sel = document.getElementById('session-access-modal-select');
            const keyInput = document.getElementById('session-access-modal-key');
            isPublic = sel && sel.value === 'public';
            classKey = keyInput ? keyInput.value.trim() : '';
        } else {
            const sel = document.getElementById('session-access-select');
            const keyInput = document.getElementById('session-class-key-input');
            isPublic = sel && sel.value === 'public';
            classKey = keyInput ? keyInput.value.trim() : '';
        }

        if (!isPublic && !classKey && !state.sessionHasClassKey) {
            showToast('Enter a class key for private sessions (4–64 characters)', 'error');
            return;
        }

        try {
            const body = { isPublic };
            if (!isPublic && classKey) body.classKey = classKey;
            const result = await api(`/sessions/${state.currentSession}/access`, {
                method: 'PUT',
                body: JSON.stringify(body)
            });
            const s = result.session || {};
            state.sessionIsPublic = s.isPublic !== false;
            state.sessionHasClassKey = !!s.hasClassKey;
            updateSessionAccessUI();
            syncSessionAccessModalFields();
            document.getElementById('session-class-key-input') &&
                (document.getElementById('session-class-key-input').value = '');
            if (fromModal) closeSessionAccessModal();
            showToast(result.message || 'Access settings saved', 'success');
        } catch (err) {
            showToast(err.message || 'Failed to save access settings', 'error');
        }
    }

    const IMPORT_MAX_FILES = 120;
    const IMPORT_MAX_FILE_BYTES = 5 * 1024 * 1024;
    const IMPORT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

    function codeNeedsStdin(code) {
        if (!code) return false;
        return /\bcin\s*>>|\bscanf\s*\(|\breadln\s*\(|\binput\s*\(|\braw_input\s*\(|\bScanner\s*\(|\bgets\s*\(|\bgetline\s*\(/i.test(code);
    }

    function syncTabOrder() {
        const order = state.tabOrder.filter((id) => state.openTabs.has(id));
        state.openTabs.forEach((id) => {
            if (!order.includes(id)) order.push(id);
        });
        state.tabOrder = order;
    }

    function updateCopyPolicyUI() {
        const wrap = document.getElementById('copy-policy-wrap');
        const toggle = document.getElementById('copy-policy-toggle');
        if (!wrap || !toggle) return;
        const show = userCanManageSessionSettings();
        wrap.style.display = show ? '' : 'none';
        toggle.checked = !!state.allowCollaboratorCopy;
    }

    function updateJoinPolicyUI() {
        const wrap = document.getElementById('join-policy-wrap');
        const sel = document.getElementById('join-policy-select');
        if (!wrap || !sel) return;
        const show = userCanManageSessionSettings();
        wrap.style.display = show ? '' : 'none';
        if (show) sel.value = state.defaultJoinRole === 'viewer' ? 'viewer' : 'editor';
    }

    function updateReferencePdfUI() {
        const pane = document.getElementById('pdf-split-pane');
        const layout = document.getElementById('editor-layout-split');
        const title = document.getElementById('pdf-split-title');
        if (!pane || !layout) return;
        const hasPdf = !!(state.referencePdf && state.referencePdf.url);
        if (hasPdf && title) {
            title.textContent = state.referencePdf.originalName || 'Reference document';
        }
        if (hasPdf) {
            const kind = getReferenceDocKind(state.referencePdf);
            const skipReload = docxEdit.dirty && kind === 'docx'
                && document.getElementById('session-docx-viewer')
                && !document.getElementById('session-docx-viewer').hidden;
            if (!skipReload) renderSessionPdf(state.referencePdf.url);
        } else {
            clearSessionPdfView();
        }
        const showSplit = hasPdf && state.pdfSplitVisible;
        layout.classList.toggle('pdf-split-active', showSplit);
        ensurePaneResizers();
        if (showSplit) {
            syncPdfCodeSplitterVisibility();
            initDocAnnotate();
            initDocxTextEditing();
            layoutMonacoEditors();
            requestAnimationFrame(() => {
                resizeAnnotateCanvas();
                updateDocxEditToolbar();
            });
        } else {
            updateDocxEditToolbar();
        }
    }

    function normalizeReferencePdf(sessOrPdf) {
        if (!sessOrPdf) return null;
        const rp = sessOrPdf.referencePdf != null ? sessOrPdf.referencePdf : sessOrPdf;
        if (!rp) return null;
        if (rp.url) {
            return {
                url: rp.url,
                originalName: rp.originalName || 'reference.pdf',
                mimeType: rp.mimeType || null,
                kind: detectReferenceKindClient(rp.originalName, rp.mimeType, rp.kind),
                editedHtml: typeof rp.editedHtml === 'string' ? rp.editedHtml : null
            };
        }
        if (rp.storageName) {
            return {
                url: `/uploads/${rp.storageName}`,
                originalName: rp.originalName || 'reference.pdf',
                mimeType: rp.mimeType || null,
                kind: detectReferenceKindClient(rp.originalName, rp.mimeType, rp.kind),
                editedHtml: typeof rp.editedHtml === 'string' ? rp.editedHtml : null
            };
        }
        return null;
    }

    function applySessionMeta(meta) {
        if (!meta) return;
        if (meta.defaultJoinRole) {
            state.defaultJoinRole = meta.defaultJoinRole === 'viewer' ? 'viewer' : 'editor';
        }
        if (meta.allowCollaboratorCopy !== undefined) {
            state.allowCollaboratorCopy = !!meta.allowCollaboratorCopy;
        }
        if (meta.referencePdf !== undefined) {
            state.referencePdf = meta.referencePdf
                ? normalizeReferencePdf({ referencePdf: meta.referencePdf })
                : null;
            if (!state.referencePdf) {
                state.pdfSplitVisible = false;
            } else if (meta.pdfSplitVisible !== undefined) {
                state.pdfSplitVisible = !!meta.pdfSplitVisible;
            } else {
                state.pdfSplitVisible = true;
            }
        }
        if (meta.owner) {
            const o = meta.owner;
            state.sessionOwnerId = (o._id || o.id || o).toString();
        }
        if (meta.isPublic !== undefined) {
            state.sessionIsPublic = meta.isPublic !== false;
        }
        if (meta.hasClassKey !== undefined) {
            state.sessionHasClassKey = !!meta.hasClassKey;
        }
        if (meta.guestCodeVisibleUntil !== undefined || meta.guestCodeVisibility || meta.codeHiddenFromGuest !== undefined) {
            applyCodeVisibilityMeta(meta);
        }
        updateJoinPolicyUI();
        updateCopyPolicyUI();
        updateReferencePdfUI();
        updateSessionAccessUI();
    }

    async function setAllowCollaboratorCopy(allowed) {
        if (!state.currentSession || !userCanManageSessionSettings()) return;
        const previous = state.allowCollaboratorCopy;
        state.allowCollaboratorCopy = !!allowed;
        updateCopyPolicyUI();
        updateSessionCopyRestrictions();
        if (state.userRole === 'viewer') setEditorReadOnly(true);
        try {
            if (state.socket && state.socket.connected) {
                state.socket.emit('set-copy-policy', {
                    sessionId: state.currentSession,
                    allowCollaboratorCopy: state.allowCollaboratorCopy
                });
            } else {
                await api(`/sessions/${state.currentSession}/copy-policy`, {
                    method: 'PUT',
                    body: JSON.stringify({ allowCollaboratorCopy: state.allowCollaboratorCopy })
                });
            }
            showToast(
                state.allowCollaboratorCopy
                    ? 'Guests can now copy, highlight, and download code'
                    : 'Guest copy, highlight, and download are now blocked',
                'success'
            );
        } catch (err) {
            state.allowCollaboratorCopy = previous;
            updateCopyPolicyUI();
            updateSessionCopyRestrictions();
            if (state.userRole === 'viewer') setEditorReadOnly(true);
            showToast(err.message || 'Failed to update copy policy', 'error');
        }
    }

    function togglePdfSplit(force) {
        if (!state.referencePdf || !state.referencePdf.url) {
            showToast('No reference document — session owner can attach PDF/DOC/DOCX from File menu', 'info');
            return;
        }
        state.pdfSplitVisible = typeof force === 'boolean' ? force : !state.pdfSplitVisible;
        updateReferencePdfUI();
    }

    async function setDefaultJoinRole(role) {
        if (!state.currentSession || !userCanManageSessionSettings()) return;
        const r = role === 'viewer' ? 'viewer' : 'editor';
        state.defaultJoinRole = r;
        updateJoinPolicyUI();
        try {
            if (state.socket && state.socket.connected) {
                state.socket.emit('set-join-policy', {
                    sessionId: state.currentSession,
                    defaultJoinRole: r
                });
            } else {
                await api(`/sessions/${state.currentSession}/join-policy`, {
                    method: 'PUT',
                    body: JSON.stringify({ defaultJoinRole: r })
                });
            }
            showToast(`New guests will join as ${r}`, 'success');
        } catch (err) {
            showToast(err.message || 'Failed to update join policy', 'error');
        }
    }

    async function uploadSessionPdf(file) {
        if (!state.currentSession || !file) return;
        if (!userCanManageSessionSettings()) {
            showToast('Only the session owner or site admin can attach a PDF', 'error');
            return;
        }
        const fd = new FormData();
        fd.append('pdf', file);
        const headers = {};
        if (state.token) headers.Authorization = `Bearer ${state.token}`;
        const res = await fetch(`${API_BASE}/sessions/${state.currentSession}/pdf`, {
            method: 'POST',
            headers,
            body: fd
        });
        const raw = await res.text();
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch (_) { /* ignore */ }
        if (!res.ok) throw new Error((data && data.error) || `Upload failed (${res.status})`);
        state.referencePdf = normalizeReferencePdf(data.referencePdf) || null;
        state.pdfSplitVisible = true;
        updateReferencePdfUI();
        if (state.socket && state.socket.connected) {
            state.socket.emit('session-pdf-updated', {
                sessionId: state.currentSession,
                referencePdf: state.referencePdf
            });
        }
        showToast('Reference document attached', 'success');
    }

    async function removeSessionPdf() {
        if (!state.currentSession) return;
        if (!userCanManageSessionSettings()) {
            showToast('Only the session owner or site admin can remove the PDF', 'error');
            return;
        }
        try {
            await api(`/sessions/${state.currentSession}/pdf`, { method: 'DELETE' });
            state.referencePdf = null;
            state.pdfSplitVisible = false;
            updateReferencePdfUI();
            if (state.socket && state.socket.connected) {
                state.socket.emit('session-pdf-updated', {
                    sessionId: state.currentSession,
                    referencePdf: null
                });
            }
            showToast('Reference document removed', 'success');
        } catch (err) {
            showToast(err.message || 'Failed to remove PDF', 'error');
        }
    }

    function updateStdinHintForCode(code, pane) {
        const needs = codeNeedsStdin(code);
        if (pane === 'split') {
            const input = document.getElementById('run-stdin-split-input');
            if (input) input.classList.toggle('stdin-needed', needs && !input.value.trim());
            return;
        }
        const hint = document.getElementById('run-stdin-hint');
        const input = document.getElementById('run-stdin-input');
        if (hint) hint.style.display = needs ? '' : 'none';
        if (input) input.classList.toggle('stdin-needed', needs && !input.value.trim());
    }

    function ensureRunPanelVisible() {
        const unifiedPanel = document.getElementById('unified-panel');
        const outputPanelContent = document.getElementById('output-panel-content');
        const previewContent = document.getElementById('preview-panel-content');
        if (unifiedPanel) unifiedPanel.style.display = '';
        if (outputPanelContent) outputPanelContent.style.display = '';
        if (previewContent) previewContent.style.display = 'none';
        document.querySelectorAll('#panel-tabs .vscode-panel-tab').forEach((t) => t.classList.remove('active'));
        const outputTab = document.querySelector('#panel-tabs .vscode-panel-tab[data-panel-tab="output"]');
        if (outputTab) outputTab.classList.add('active');
    }

    let tabDragFileId = null;

    function initTabDragReorder() {
        const tabsContainer = document.getElementById('editor-tabs');
        if (!tabsContainer || tabsContainer.dataset.tabDragBound) return;
        tabsContainer.dataset.tabDragBound = '1';

        tabsContainer.addEventListener('dragstart', (e) => {
            const tab = e.target.closest('.editor-tab');
            if (!tab || !tab.dataset.fileId) return;
            tabDragFileId = tab.dataset.fileId;
            tab.classList.add('tab-dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', tabDragFileId);
        });

        tabsContainer.addEventListener('dragend', (e) => {
            const tab = e.target.closest('.editor-tab');
            if (tab) tab.classList.remove('tab-dragging');
            tabsContainer.querySelectorAll('.editor-tab').forEach((t) => t.classList.remove('tab-drag-over'));
            tabDragFileId = null;
        });

        tabsContainer.addEventListener('dragover', (e) => {
            e.preventDefault();
            const tab = e.target.closest('.editor-tab');
            if (!tab || !tab.dataset.fileId) return;
            tabsContainer.querySelectorAll('.editor-tab').forEach((t) => t.classList.remove('tab-drag-over'));
            tab.classList.add('tab-drag-over');
        });

        tabsContainer.addEventListener('drop', (e) => {
            e.preventDefault();
            const tab = e.target.closest('.editor-tab');
            if (!tab || !tabDragFileId) return;
            const targetId = tab.dataset.fileId;
            if (targetId === tabDragFileId) return;
            syncTabOrder();
            const from = state.tabOrder.indexOf(tabDragFileId);
            const to = state.tabOrder.indexOf(targetId);
            if (from < 0 || to < 0) return;
            state.tabOrder.splice(from, 1);
            state.tabOrder.splice(to, 0, tabDragFileId);
            renderTabs();
        });
    }

    function isFileDragEvent(e) {
        if (!e.dataTransfer) return false;
        const types = Array.from(e.dataTransfer.types || []);
        return types.includes('Files');
    }

    function initWorkspaceDragDrop() {
        const root = document.getElementById('editor-view');
        const body = document.getElementById('vscode-body');
        const overlay = document.getElementById('workspace-drop-overlay');
        if (!root || root.dataset.workspaceDropBound) return;
        root.dataset.workspaceDropBound = '1';
        let depth = 0;

        const canImport = () =>
            state.currentView === 'editor'
            && state.currentSession
            && userCanEditSession();

        const showOverlay = () => {
            if (overlay) {
                overlay.style.display = '';
                overlay.setAttribute('aria-hidden', 'false');
            }
        };
        const hideOverlay = () => {
            if (overlay) {
                overlay.style.display = 'none';
                overlay.setAttribute('aria-hidden', 'true');
            }
        };

        const onDragEnter = (e) => {
            if (!canImport() || !isFileDragEvent(e)) return;
            e.preventDefault();
            e.stopPropagation();
            depth += 1;
            showOverlay();
        };

        const onDragLeave = (e) => {
            if (!overlay || overlay.style.display === 'none') return;
            if (e.relatedTarget && body && body.contains(e.relatedTarget)) return;
            depth = Math.max(0, depth - 1);
            if (depth === 0) hideOverlay();
        };

        const onDragOver = (e) => {
            if (!state.currentView || state.currentView !== 'editor') return;
            if (!isFileDragEvent(e)) return;
            e.preventDefault();
            e.stopPropagation();
            if (canImport()) {
                e.dataTransfer.dropEffect = 'copy';
            } else {
                e.dataTransfer.dropEffect = 'none';
            }
        };

        const onDrop = async (e) => {
            if (!isFileDragEvent(e)) return;
            e.preventDefault();
            e.stopPropagation();
            depth = 0;
            hideOverlay();
            if (!canImport()) {
                showToast('Viewers cannot import files. Ask the owner for editor access.', 'error');
                return;
            }
            const files = e.dataTransfer && e.dataTransfer.files;
            if (!files || !files.length) return;
            await importLocalFolder(files);
        };

        // Capture phase so drops on sidebar/workspace win over the browser opening a new tab
        root.addEventListener('dragenter', onDragEnter, true);
        root.addEventListener('dragleave', onDragLeave, true);
        root.addEventListener('dragover', onDragOver, true);
        root.addEventListener('drop', onDrop, true);
    }

    const LOCAL_IMPORT_EXT = new Set([
        '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.html', '.htm', '.css', '.scss', '.less',
        '.json', '.md', '.markdown', '.txt', '.py', '.java', '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp',
        '.go', '.rs', '.php', '.rb', '.yml', '.yaml', '.sql', '.sh', '.bash', '.xml', '.svg', '.vue', '.svelte'
    ]);

    function localImportPathOk(relPath) {
        const n = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
        if (!n || n.includes('..')) return false;
        const parts = n.split('/').filter(Boolean);
        for (const seg of parts) {
            if (seg.startsWith('.')) return false;
            if (seg === 'node_modules' || seg === 'dist' || seg === 'build' || seg === 'vendor'
                || seg === '.git' || seg === '__pycache__') return false;
        }
        const lower = n.toLowerCase();
        if (lower.includes('package-lock.json') || lower.includes('yarn.lock')) return false;
        const dot = lower.lastIndexOf('.');
        const ext = dot >= 0 ? lower.slice(dot) : '';
        if (LOCAL_IMPORT_EXT.has(ext)) return true;
        const base = parts[parts.length - 1] || '';
        return ['dockerfile', 'makefile', 'gemfile', 'rakefile', 'readme', 'license'].includes(base);
    }

    function readFileAsText(file) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result);
            r.onerror = () => reject(r.error || new Error('Failed to read file'));
            r.readAsText(file, 'UTF-8');
        });
    }

    function applyReloadedSessionFiles(clientFiles) {
        state.files.clear();
        state.openTabs.clear();
        let firstFileId = null;
        const entries = Object.entries(clientFiles || {});
        for (const [id, fileData] of entries) {
            const doc = fileDocFromPayload(fileData);
            const lang = resolveEditorLanguage({
                name: fileData.name,
                language: fileData.language,
                doc
            }, doc);
            state.files.set(id, {
                id: fileData.id || id,
                name: fileData.name,
                doc,
                language: lang,
                version: fileData.version || 0
            });
            if (!firstFileId) firstFileId = id;
        }
        if (firstFileId) {
            openFile(firstFileId);
        } else {
            state.activeFileId = null;
            const container = document.getElementById('editor-container');
            if (container) container.innerHTML = '';
            if (state.editorView) {
                state.editorView.dispose();
                state.editorView = null;
            }
        }
        renderFileTree();
        renderTabs();
        setSaveStatus('saved');
    }

    function reloadSessionFilesFromDb() {
        return new Promise((resolve) => {
            if (!state.socket || !state.currentSession) {
                resolve();
                return;
            }
            const onReload = (data) => {
                clearTimeout(timer);
                state.socket.off('session-files-reloaded', onReload);
                applyReloadedSessionFiles(data.files);
                resolve();
            };
            const timer = setTimeout(() => {
                state.socket.off('session-files-reloaded', onReload);
                resolve();
            }, 12000);
            state.socket.on('session-files-reloaded', onReload);
            state.socket.emit('reload-session-from-db', { sessionId: state.currentSession });
        });
    }

    function getRunStdin(pane) {
        if (pane === 'split') return getSplitStdin();
        const el = document.getElementById('run-stdin-input');
        return el ? el.value : '';
    }

    function persistRunStdin() {
        if (!state.currentSession) return;
        try {
            sessionStorage.setItem(`codemesh_stdin_${state.currentSession}`, getRunStdin('primary'));
        } catch (_) { /* quota */ }
        if (state.editorView) updateStdinHintForCode(state.editorView.getValue(), 'primary');
    }

    function restoreRunStdin() {
        const el = document.getElementById('run-stdin-input');
        if (!el || !state.currentSession) return;
        try {
            const saved = sessionStorage.getItem(`codemesh_stdin_${state.currentSession}`);
            if (saved != null) el.value = saved;
        } catch (_) { /* ignore */ }
        restoreSplitStdin();
        restoreSplitScratch();
    }

    async function importLocalFolder(fileList) {
        if (!state.currentSession) {
            showToast('Open a session first', 'error');
            return;
        }
        if (!userCanEditSession()) {
            showToast('Viewers cannot import files. Ask the owner for editor access.', 'error');
            return;
        }
        const picked = Array.from(fileList || []);
        if (!picked.length) return;

        const payload = [];
        let totalBytes = 0;

        picked.sort((a, b) => {
            const pa = (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name);
            return pa;
        });

        for (const file of picked) {
            if (payload.length >= IMPORT_MAX_FILES) break;
            const rel = (file.webkitRelativePath || file.name).replace(/\\/g, '/');
            if (!localImportPathOk(rel)) continue;
            if (file.size > IMPORT_MAX_FILE_BYTES) continue;
            if (totalBytes + file.size > IMPORT_MAX_TOTAL_BYTES) break;
            try {
                const content = await readFileAsText(file);
                const bytes = new Blob([content]).size;
                if (bytes > IMPORT_MAX_FILE_BYTES) continue;
                if (totalBytes + bytes > IMPORT_MAX_TOTAL_BYTES) break;
                totalBytes += bytes;
                payload.push({ name: rel, content });
            } catch (_) { /* skip unreadable */ }
        }

        if (!payload.length) {
            showToast('No suitable text files (max 120 files, 5MB each, 50MB total)', 'error');
            return;
        }

        try {
            const result = await api(`/sessions/${state.currentSession}/import-files`, {
                method: 'POST',
                body: JSON.stringify({ files: payload })
            });
            showToast(result.message || `Imported ${payload.length} file(s)`, 'success');
            await reloadSessionFilesFromDb();
        } catch (err) {
            showToast(err.message || 'Import failed', 'error');
        }
    }

    async function importGitHubIntoCurrentSession() {
        if (!state.currentSession) {
            showToast('Open a session first', 'error');
            return;
        }
        if (!userCanEditSession()) {
            showToast('Viewers cannot import from GitHub. Ask the owner for editor access.', 'error');
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
        const subdirRaw = window.prompt('Folder inside repo (optional, e.g. src or homework/lab1):', '');
        try {
            const result = await api(`/sessions/${state.currentSession}/import-github`, {
                method: 'POST',
                body: JSON.stringify({
                    repo,
                    branch: branchRaw && branchRaw.trim() ? branchRaw.trim() : undefined,
                    subdir: subdirRaw && subdirRaw.trim() ? subdirRaw.trim() : undefined
                })
            });
            showToast(result.message || 'Import complete', 'success');
            if (result.reloadLive) await reloadSessionFilesFromDb();
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
          <div class="session-card-title">${escapeHtml(s.title)}${s.isPublic === false ? '<span class="session-card-private-badge" title="Private — class key required">🔒 Private</span>' : ''}</div>
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
            const classKey = getDashboardClassKey();
            openEditor(id, classKey ? { classKey } : {});
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
        return langMap[lang] || 'plaintext';
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
            '.txt': 'plaintext',
            '.gitkeep': 'plaintext'
        };
        return byExt[ext] || 'plaintext';
    }

    /** Best-effort language from first lines of content (when name has no real extension). */
    function inferLanguageFromContent(text) {
        const s = String(text || '').slice(0, 24000);
        const head = s.slice(0, 8000).trimStart().toLowerCase();
        if (!head) return 'plaintext';
        if (/<!doctype\s+html\b/.test(head) || /<html[\s>]/.test(head) || /<head[\s>]/.test(head) || /<body[\s>]/.test(head)) {
            return 'html';
        }
        if (head.startsWith('#!/usr/bin/env bash') || head.startsWith('#!/bin/bash') || head.startsWith('#!/bin/sh')) {
            return 'shell';
        }
        if (/\bfn\s+main\s*\(/.test(head) && (head.includes('use std::') || head.includes('println!'))) {
            return 'rust';
        }
        if (/^\s*package\s+main\b/m.test(s) && /\bfunc\s+main\s*\(/.test(s)) {
            return 'go';
        }
        if (head.includes('<?php')) {
            return 'php';
        }
        if (/#include\s*<iostream/.test(head) || /using\s+namespace\s+std\b/.test(head) || /\bstd::\w+/.test(head)) {
            return 'cpp';
        }
        if (/#include\s*<stdio\.h>/.test(head) || (/\bint\s+main\s*\(\s*\)/.test(head) && head.includes('#include'))) {
            return 'c';
        }
        if (/\bpublic\s+static\s+void\s+main\s*\(/.test(head) || /\bpublic\s+class\s+\w+/.test(head)) {
            return 'java';
        }
        if (/^\s*import\s+[\w.]+\s*$/m.test(s) && /^\s*(from\s+[\w.]+\s+import|def\s+\w+\s*\()/m.test(s)) {
            return 'python';
        }
        if (/^\s*def\s+\w+\s*\(/m.test(s) || /^\s*class\s+\w+\s*(\(|:)/m.test(s)) {
            return 'python';
        }
        if (/^\s*(import|export)\s+.+from\s+['"]/m.test(s) || /\btype\s+\w+\s*=/m.test(head)) {
            return 'typescript';
        }
        if (/^\s*import\s+/.test(head) && /['"]use strict['"]/.test(head)) {
            return 'javascript';
        }
        if (/^\s*function\s+\w+\s*\(/.test(head) || /^\s*(const|let|var)\s+\w+\s*=/.test(head)) {
            return 'javascript';
        }
        return 'plaintext';
    }

    const EXT_FOR_LANG = {
        javascript: '.js',
        typescript: '.ts',
        python: '.py',
        html: '.html',
        css: '.css',
        java: '.java',
        cpp: '.cpp',
        c: '.c',
        csharp: '.cs',
        go: '.go',
        rust: '.rs',
        php: '.php',
        ruby: '.rb',
        sql: '.sql',
        markdown: '.md',
        json: '.json',
        yaml: '.yaml',
        xml: '.xml',
        shell: '.sh',
        scss: '.scss',
        less: '.less',
        plaintext: '.txt'
    };

    function extensionForLanguage(lang) {
        return EXT_FOR_LANG[lang] || '.txt';
    }

    /** Only auto-rename the default scratch file, not arbitrary user .txt names. */
    function shouldAutoRenameSnippetTxtName(fullPath) {
        const base = (fullPath || '').split(/[/\\]/).pop() || '';
        const lower = base.toLowerCase();
        return lower === 'snippet.txt' || lower === 'snippet.text';
    }

    function workspacePathsExcluding(excludeFileId) {
        const taken = new Set();
        state.files.forEach((f, id) => {
            if (id === excludeFileId) return;
            taken.add(String(f.name || '').replace(/\\/g, '/'));
        });
        return taken;
    }

    /** Build `dir + stem + ext` or stem2, stem3… if taken (same folder). */
    function uniqueNameInWorkspace(dir, stem, ext, excludeFileId) {
        const prefix = dir ? String(dir).replace(/\\/g, '/') : '';
        const taken = workspacePathsExcluding(excludeFileId);
        const tryFull = (base) => {
            const full = prefix + base;
            return taken.has(full) ? null : full;
        };
        let candidate = tryFull(stem + ext);
        if (candidate) return candidate;
        for (let i = 2; i < 100; i++) {
            candidate = tryFull(stem + i + ext);
            if (candidate) return candidate;
        }
        return prefix + stem + '_' + Date.now() + ext;
    }

    /**
     * When the default scratch file is still .txt but content clearly matches another language,
     * rename on disk/session (e.g. snippet.txt → snippet.cpp).
     */
    function tryAutoRenameForInferredLang(file, textOverride) {
        if (!file || !state.socket || !state.currentSession || !state.activeFileId) return;
        if (file.id !== state.activeFileId) return;
        if (state.userRole === 'viewer') return;
        if (inferLanguageFromFileName(file.name) !== 'plaintext') return;
        if (!shouldAutoRenameSnippetTxtName(file.name)) return;
        const txt = textOverride != null ? textOverride : (state.editorView ? state.editorView.getValue() : file.doc) || '';
        const next = inferLanguageFromContent(txt);
        if (next === 'plaintext') return;
        const wantExt = extensionForLanguage(next);
        const norm = String(file.name || '').replace(/\\/g, '/');
        const parts = norm.split('/').filter(Boolean);
        if (!parts.length) return;
        const base = parts[parts.length - 1];
        if (base.toLowerCase().endsWith(wantExt.toLowerCase())) return;
        const dir = parts.length > 1 ? parts.slice(0, -1).join('/') + '/' : '';
        let stem = base.replace(/\.(txt|text)$/i, '');
        if (!stem) stem = 'snippet';
        const newFull = uniqueNameInWorkspace(dir, stem, wantExt, state.activeFileId);
        if (newFull !== file.name) {
            state.socket.emit('rename-file', {
                sessionId: state.currentSession,
                fileId: state.activeFileId,
                newName: newFull
            });
        }
    }

    function resolveEditorLanguage(file, text) {
        const doc = text != null
            ? text
            : (file && (file.doc != null ? file.doc : file.content)) || '';
        const fromName = inferLanguageFromFileName((file && file.name) || '');
        if (fromName !== 'plaintext') return fromName;
        return inferLanguageFromContent(doc);
    }

    function downloadTextAsFile(text, filename) {
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        showToast(`Downloaded ${filename}`, 'success');
    }

    function downloadActiveFile() {
        if (state.splitActive && state.focusedPane === 'split') {
            downloadSplitScratch();
            return;
        }
        if (!userCanCopySessionCode()) {
            showToast('Guest copy is disabled for this session', 'info');
            return;
        }
        const file = state.activeFileId ? state.files.get(state.activeFileId) : null;
        if (!file || !state.editorView) return;
        const text = state.editorView.getValue();
        const lang = resolveEditorLanguage(file, text);
        const baseFromPath = (file.name || 'snippet').split('/').pop() || 'snippet';
        const hasKnownExt = /\.[a-zA-Z0-9]{1,12}$/.test(baseFromPath);
        let filename = baseFromPath;
        if (!hasKnownExt) {
            filename = `snippet${extensionForLanguage(lang)}`;
        }
        downloadTextAsFile(text, filename);
    }

    function downloadSplitScratch() {
        if (state.userRole === 'viewer') {
            showToast('Downloading is disabled for viewers', 'info');
            return;
        }
        if (!state.splitActive || !state.splitEditor) {
            showToast('Open the split test pane first', 'info');
            return;
        }
        syncSplitScratchFromLeft();
        state.splitScratch.doc = state.splitEditor.getValue();
        const filename = getSplitScratchDisplayName();
        downloadTextAsFile(state.splitScratch.doc, filename);
    }

    let languageInferTimer = null;
    function scheduleLanguageReinferFromContent() {
        const file = state.activeFileId ? state.files.get(state.activeFileId) : null;
        if (!file || !state.editorView || !state.socket || !state.currentSession) return;
        if (inferLanguageFromFileName(file.name) !== 'plaintext') return;
        clearTimeout(languageInferTimer);
        languageInferTimer = setTimeout(() => {
            const f = state.activeFileId ? state.files.get(state.activeFileId) : null;
            if (!f || !state.editorView || !state.socket || !state.currentSession) return;
            const txt = state.editorView.getValue();
            const next = inferLanguageFromContent(txt);
            if (next !== f.language) {
                f.language = next;
                monaco.editor.setModelLanguage(state.editorView.getModel(), mapLanguageToMonaco(next));
                updateStatusbarLanguage(next);
                renderFileTree();
                renderTabs();
                state.socket.emit('language-change', {
                    sessionId: state.currentSession,
                    fileId: state.activeFileId,
                    language: next
                });
            }
            tryAutoRenameForInferredLang(f, txt);
        }, 450);
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





    function createEditor(container, doc, language, fileId) {
        const editor = monaco.editor.create(container, {
            value: doc,
            language: mapLanguageToMonaco(language),
            theme: 'vs-dark',
            fontFamily: EDITOR_FONT_FAMILY,
            fontLigatures: false,
            automaticLayout: true,
            glyphMargin: true,
            readOnly: state.userRole === 'viewer',
            minimap: { enabled: false },
            wordWrap: "on",
            padding: { top: 10 },
            selectionClipboard: fileId === SPLIT_SCRATCH_ID || userCanCopySessionCode(),
            selectionHighlight: fileId === SPLIT_SCRATCH_ID || userCanCopySessionCode()
        });

        editor.onDidChangeModelContent((e) => {
            if (state.isApplyingRemote) return;
            handleLocalChange(e, fileId, editor);
            if (fileId === getFocusedFileId()) {
                updateStdinHintForCode(editor.getValue());
            }
        });

        editor.onDidChangeCursorSelection((e) => {
            if (!userCanCopySessionCode() && fileId !== SPLIT_SCRATCH_ID && !e.selection.isEmpty()) {
                collapseSessionSelection(editor, fileId);
                return;
            }
            handleCursorUpdate(e, fileId);
        });

        editor.onMouseDown((e) => {
            if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS) {
                openCommentDialog(e.target.position.lineNumber);
            }
        });

        attachSessionEditorCopyGuards(editor, fileId);

        updateStdinHintForCode(doc, fileId === SPLIT_SCRATCH_ID ? 'split' : 'primary');
        layoutMonacoEditor();
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

    function handleLocalChange(e, fileId, editor) {
        if (!fileId) return;

        if (fileId === SPLIT_SCRATCH_ID) {
            state.splitScratch.doc = editor.getValue();
            persistSplitScratch();
            if (getFocusedFileId() === SPLIT_SCRATCH_ID) {
                updateStdinHintForCode(editor.getValue(), 'split');
            }
            return;
        }

        if (!state.socket || !state.currentSession) return;

        const model = editor.getModel();
        if (!model) return;

        for (const change of e.changes) {
            const { rangeOffset, rangeLength, text } = change;
            if (rangeLength > 0) {
                pendingLocalOps.push({ type: 'delete', pos: rangeOffset, count: rangeLength, fileId });
            }
            if (text && text.length > 0) {
                pendingLocalOps.push({ type: 'insert', pos: rangeOffset, text, fileId });
            }
        }

        if (!localBatchTimer) {
            localBatchTimer = setTimeout(() => {
                const opsToSend = pendingLocalOps.splice(0);
                const byFile = new Map();
                for (const op of opsToSend) {
                    const fid = op.fileId;
                    if (!byFile.has(fid)) byFile.set(fid, []);
                    byFile.get(fid).push(op);
                }
                byFile.forEach((ops, fid) => {
                    const file = state.files.get(fid);
                    const currentVersion = file ? file.version : state.serverVersion;
                    ops.forEach(op => {
                        state.socket.emit('code-change', {
                            sessionId: state.currentSession,
                            fileId: fid,
                            op: { type: op.type, pos: op.pos, count: op.count, text: op.text },
                            version: currentVersion
                        });
                    });
                    const ed = getEditorForFileId(fid);
                    if (file && ed) file.doc = ed.getValue();
                });
                if (byFile.has(state.activeFileId)) scheduleLanguageReinferFromContent();
                localBatchTimer = null;
            }, LOCAL_BATCH_MS);
        }

        if (userCanEditSession()) {
            setSaveStatus('unsaved');
            clearTimeout(state.saveTimer);
            state.saveTimer = setTimeout(() => manualSave(), 5000);
        }
    }

    // ─── Remote Changes → Editor (batched for performance) ───
    let pendingRemoteOps = [];
    let remoteBatchTimer = null;
    const REMOTE_BATCH_MS = 16; // ~1 frame at 60fps

    function applyRemoteChange(op, fileId) {
        const editor = getEditorForFileId(fileId);
        if (!editor) return;

        pendingRemoteOps.push({ op, fileId });

        if (!remoteBatchTimer) {
            remoteBatchTimer = requestAnimationFrame(() => {
                if (pendingRemoteOps.length === 0) {
                    remoteBatchTimer = null;
                    return;
                }

                state.isApplyingRemote = true;
                try {
                    const batch = pendingRemoteOps.splice(0);
                    const byFile = new Map();
                    for (const item of batch) {
                        if (!byFile.has(item.fileId)) byFile.set(item.fileId, []);
                        byFile.get(item.fileId).push(item.op);
                    }
                    byFile.forEach((ops, fid) => {
                        const ed = getEditorForFileId(fid);
                        if (!ed) return;
                        const model = ed.getModel();
                        if (!model) return;
                        const edits = [];
                        for (const remoteOp of ops) {
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
                        if (edits.length > 0) ed.executeEdits('remote', edits);
                        const file = state.files.get(fid);
                        if (file) file.doc = ed.getValue();
                    });
                } finally {
                    state.isApplyingRemote = false;
                    remoteBatchTimer = null;
                }
            });
        }
    }

    // ─── Cursor Broadcasting ───
    let cursorTimer = null;
    function handleCursorUpdate(e, fileId) {
        if (!fileId) return;
        if (fileId !== getFocusedFileId()) return;
        const editor = getEditorForFileId(fileId);
        if (!editor) return;
        clearTimeout(cursorTimer);
        cursorTimer = setTimeout(() => {
            const selection = editor.getSelection();
            if (!selection) return;

            const model = editor.getModel();
            if (!model) return;

            if (fileId !== SPLIT_SCRATCH_ID) {
                if (!state.socket || !state.currentSession) return;
                const headOffset = model.getOffsetAt({ lineNumber: selection.positionLineNumber, column: selection.positionColumn });
                const fromOffset = model.getOffsetAt({ lineNumber: selection.startLineNumber, column: selection.startColumn });
                const toOffset = model.getOffsetAt({ lineNumber: selection.endLineNumber, column: selection.endColumn });

                state.socket.emit('cursor-update', {
                    sessionId: state.currentSession,
                    fileId,
                    cursor: { line: selection.positionLineNumber, ch: selection.positionColumn },
                    selection: { from: fromOffset, to: toOffset, head: headOffset }
                });
            }

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
        if (!userCanEditSession()) {
            showToast('Viewers cannot save edits to the session', 'info');
            return;
        }
        setSaveStatus('saving');
        try {
            syncAllOpenEditorsToFiles();
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
    async function openEditor(sessionId, options = {}) {
        const initialClassKey = options.classKey || state.pendingClassKey || getDashboardClassKey() || null;
        if (initialClassKey) state.pendingClassKey = initialClassKey;

        try {
            const sessionData = await openEditorWithAccess(sessionId, initialClassKey || undefined);
            const socketClassKey = state.pendingClassKey;
            state.pendingClassKey = null;

            showView('editor');

            // Show loading state in editor
            const container = document.getElementById('editor-container');
            container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);">Loading editor...</div>';

            await loadMonaco();

            state.currentSession = sessionId;
            state.sessionIsPublic = sessionData.isPublic !== false;
            state.sessionHasClassKey = !!sessionData.hasClassKey;
            if (state.terminal) { state.terminal.dispose(); state.terminal = null; }

            // Update URL to /sessionId for shareable links
            const path = sessionEditorPath(sessionId);
            if (window.location.pathname !== path) {
                history.replaceState({ sessionId }, '', path);
            }

            // Update UI
            document.getElementById('editor-session-title').textContent = sessionData.title;
            document.getElementById('editor-session-id').textContent = `${sessionId}`;
            setDocumentTitle(`${sessionData.title || sessionId} · CodeMesh`);

            const firstLang = (sessionData.files && sessionData.files.length > 0)
                ? resolveEditorLanguage({
                    name: sessionData.files[0].name,
                    language: sessionData.files[0].language,
                    doc: sessionData.files[0].content || ''
                })
                : (sessionData.language || 'plaintext');
            updateStatusbarLanguage(firstLang);

            // Clear and create editor
            container.innerHTML = '';
            if (state.editorView) {
                state.editorView.dispose();
                state.editorView = null;
            }

            const firstFromApi = hydrateFilesFromSessionPayload(sessionData);
            if (firstFromApi) {
                openFile(firstFromApi);
            }

            applySessionMeta({
                defaultJoinRole: sessionData.defaultJoinRole,
                allowCollaboratorCopy: sessionData.allowCollaboratorCopy,
                referencePdf: sessionData.referencePdf,
                pdfSplitVisible: sessionData.referencePdf ? true : false,
                owner: sessionData.owner,
                isPublic: sessionData.isPublic,
                hasClassKey: sessionData.hasClassKey,
                guestCodeVisibleUntil: sessionData.guestCodeVisibleUntil,
                guestCodeVisibility: sessionData.guestCodeVisibility,
                codeHiddenFromGuest: sessionData.codeHiddenFromGuest
            });

            // Connect WebSocket
            connectSocket(sessionId, sessionData, socketClassKey);
            restoreRunStdin();
            initWorkspaceDragDrop();
            initTabDragReorder();

        } catch (err) {
            setDocumentTitle(DEFAULT_DOC_TITLE);
            if (!err.cancelled) {
                showToast('Failed to open editor: ' + err.message, 'error');
            }
            loadDashboard();
        }
    }

    // ─── WebSocket Connection ───
    function connectSocket(sessionId, sessionData, classKey) {
        stopCodeVisibilityCountdown();
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
                userId: state.user ? (state.user.id || state.user._id) : null,
                classKey: classKey || undefined
            });
        });

        state.socket.on('session-state', (data) => {
            // Set user role
            state.userRole = data.role || 'editor';
            updateRoleBadge(state.userRole);
            applySessionMeta({
                defaultJoinRole: data.defaultJoinRole,
                allowCollaboratorCopy: data.allowCollaboratorCopy,
                referencePdf: data.referencePdf,
                pdfSplitVisible: data.pdfSplitVisible,
                guestCodeVisibleUntil: data.guestCodeVisibleUntil,
                guestCodeVisibility: data.guestCodeVisibility,
                codeHiddenFromGuest: data.codeHiddenFromGuest
            });
            setEditorReadOnly(state.userRole === 'viewer' || !userCanViewSessionCode());
            updateSessionCopyRestrictions();

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
            state.tabOrder = [];
            
            let firstFileId = null;
            if (data.files && Object.keys(data.files).length > 0) {
                for (const [id, fileData] of Object.entries(data.files)) {
                    const doc = fileDocFromPayload(fileData);
                    const lang = resolveEditorLanguage({
                        name: fileData.name,
                        language: fileData.language,
                        doc
                    });
                    state.files.set(id, {
                        id: fileData.id,
                        name: fileData.name,
                        doc,
                        language: lang,
                        version: fileData.version || 0
                    });
                    if (!firstFileId) firstFileId = id;
                }
            } else {
                // Fallback for empty state
                firstFileId = 'main_file';
                state.files.set(firstFileId, {
                    id: firstFileId,
                    name: 'snippet.txt',
                    doc: '',
                    language: 'plaintext',
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
                    openFileInPrimary(Array.from(state.openTabs)[0]);
                } else if (state.files.size > 0) {
                    openFileInPrimary(Array.from(state.files.keys())[0]);
                } else {
                    state.activeFileId = null;
                    document.getElementById('editor-container').innerHTML = '';
                    if (state.editorView) {
                        state.editorView.dispose();
                        state.editorView = null;
                    }
                    disableEditorSplit();
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

        state.socket.on('session-files-reloaded', (data) => {
            applyReloadedSessionFiles(data.files);
            showToast('Workspace files updated', 'info');
        });

        state.socket.on('join-policy-changed', (data) => {
            if (!data) return;
            state.defaultJoinRole = data.defaultJoinRole === 'viewer' ? 'viewer' : 'editor';
            updateJoinPolicyUI();
        });

        state.socket.on('copy-policy-changed', (data) => {
            if (!data || data.allowCollaboratorCopy === undefined) return;
            state.allowCollaboratorCopy = !!data.allowCollaboratorCopy;
            updateCopyPolicyUI();
            updateSessionCopyRestrictions();
            if (state.userRole === 'viewer') setEditorReadOnly(true);
            if (!userCanManageSessionSettings()) {
                showToast(
                    state.allowCollaboratorCopy
                        ? 'The owner enabled copy, highlight, and download for guests'
                        : 'The owner disabled guest copy, highlight, and download',
                    'info'
                );
            }
        });

        state.socket.on('code-visibility-changed', (data) => {
            handleCodeVisibilityChanged(data);
        });

        state.socket.on('access-settings-changed', (data) => {
            if (!data) return;
            state.sessionIsPublic = data.isPublic !== false;
            state.sessionHasClassKey = !!data.hasClassKey;
            updateSessionAccessUI();
            syncSessionAccessModalFields();
        });

        state.socket.on('reference-pdf-changed', (data) => {
            if (!data) return;
            if (docxEdit.dirty && docxEdit.active) {
                // Keep local unsaved edits; only refresh metadata when idle.
                return;
            }
            state.referencePdf = data.referencePdf
                ? normalizeReferencePdf({ referencePdf: data.referencePdf })
                : null;
            if (data.pdfSplitVisible != null) {
                state.pdfSplitVisible = !!data.pdfSplitVisible;
            } else if (state.referencePdf) {
                state.pdfSplitVisible = true;
            } else {
                state.pdfSplitVisible = false;
            }
            docxEdit.dirty = false;
            updateReferencePdfUI();
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
                    applyRemoteChange(op, fileId);
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
                    applyLanguageToActiveEditor(language);
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
            updateSessionCopyRestrictions();
            showToast(
                data.message || (data.role === 'viewer'
                    ? 'You are a viewer: read-only in this session.'
                    : 'Role updated'),
                data.role === 'viewer' ? 'info' : 'success'
            );
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

    // ─── Apply language to Monaco + UI (no socket emit; use for remote language-changed) ───
    function applyLanguageToActiveEditor(lang) {
        if (!state.editorView || !monacoLoaded) return;
        monaco.editor.setModelLanguage(state.editorView.getModel(), mapLanguageToMonaco(lang));
        updateRemoteSelections();
        renderFileTree();
        renderTabs();
        updateStatusbarLanguage(lang);
    }

    // ─── User-initiated language change (emits to server) ───
    function reconfigureLanguage(lang) {
        const fileId = getFocusedFileId();
        const editor = getFocusedEditor();
        if (!editor || !monacoLoaded || !fileId) return;

        if (fileId === SPLIT_SCRATCH_ID) {
            setSplitScratchLanguage(lang, true);
            return;
        }

        if (state.socket && state.currentSession) {
            state.socket.emit('language-change', {
                sessionId: state.currentSession,
                fileId,
                language: lang
            });
            const file = state.files.get(fileId);
            if (file) file.language = lang;
        }

        applyLanguageToActiveEditor(lang);
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
        else if (lang === 'cpp' || lang === 'c') { iconClass = 'codicon-symbol-misc'; iconColor = '#6594b3'; }
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
                const lang = resolveEditorLanguage(file, file.doc);
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
            window.openFile(row.dataset.fileId, e);
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

        syncTabOrder();
        let html = '';
        state.tabOrder.forEach(id => {
            if (!state.openTabs.has(id)) return;
            const file = state.files.get(id);
            if (!file) {
                state.openTabs.delete(id);
                return;
            }
            
            const lang = resolveEditorLanguage(file, file.doc);
            let iconClass = 'codicon-file';
            let iconColor = '#519aba';
            if (lang === 'html') { iconClass = 'codicon-code'; iconColor = '#e34c26'; }
            else if (lang === 'css') { iconClass = 'codicon-symbol-color'; iconColor = '#563d7c'; }
            else if (lang === 'python') { iconClass = 'codicon-symbol-misc'; iconColor = '#3572A5'; }
            else if (lang === 'java') { iconClass = 'codicon-symbol-class'; iconColor = '#b07219'; }
            else if (lang === 'cpp' || lang === 'c') { iconClass = 'codicon-symbol-misc'; iconColor = '#555555'; }
            else if (lang === 'javascript' || lang === 'typescript') { iconClass = 'codicon-symbol-class'; iconColor = '#f1e05a'; }
            else if (lang === 'plaintext') { iconClass = 'codicon-file'; iconColor = '#6e7681'; }

            const isActive = id === state.activeFileId ? 'active' : '';
            const tabLabel = fileBasename(file.name);
            html += `
                <div class="editor-tab ${isActive}" draggable="true" data-file-id="${id}" onclick="openFile('${id}', event)" title="Alt+click: copy name &amp; language to right test pane">
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

    function openFileInPrimary(fileId) {
        if (!state.files.has(fileId)) return;

        state.activeFileId = fileId;
        state.openTabs.add(fileId);
        syncTabOrder();
        state.focusedPane = 'primary';

        const file = state.files.get(fileId);

        if (!userCanViewSessionCode() && !userCanManageSessionSettings()) {
            updateCodeRestrictedUI();
            file.language = resolveEditorLanguage(file, file.doc);
            updateStatusbarLanguage(file.language);
            renderFileTree();
            renderTabs();
            updateSplitLayout();
            return;
        }

        const container = document.getElementById('editor-container');
        if (state.editorView) state.editorView.dispose();
        state.editorView = mountEditorInContainer(container, fileId);
        if (state.editorView) {
            state.editorView.onDidFocusEditorWidget(() => {
                state.focusedPane = 'primary';
                updateStatusbarLanguage(resolveEditorLanguage(file, file.doc));
                updateSplitPaneFocusStyles();
            });
        }

        if (state.splitActive) syncSplitScratchFromLeft();

        if (state.userRole === 'viewer') setEditorReadOnly(true);
        updateSessionCopyRestrictions();

        file.language = resolveEditorLanguage(file, file.doc);
        updateStatusbarLanguage(file.language);

        if (state.socket && state.currentSession) {
            tryAutoRenameForInferredLang(file, file.doc);
        }

        updateStdinHintForCode(file.doc, 'primary');
        renderFileTree();
        renderTabs();
        updateSplitLayout();
        layoutMonacoEditors();
        updateRemoteSelections();
        updateCommentGutter();
    }

    function openScratchFromTab(fileId) {
        if (!state.files.has(fileId)) return;
        const file = state.files.get(fileId);
        const base = fileBasename(file.name);
        const dot = base.lastIndexOf('.');
        state.splitScratch.sourceStem = dot > 0 ? base.slice(0, dot) : base;
        state.splitScratch.language = resolveEditorLanguage(file, file.doc);
        if (!state.splitActive) enableEditorSplit();
        else {
            updateSplitPaneUI();
            mountSplitEditor();
        }
        state.focusedPane = 'split';
        updateStatusbarLanguage(state.splitScratch.language);
        state.splitEditor?.focus();
    }

    window.openFile = function(fileId, ev) {
        if (!state.files.has(fileId)) return;
        const openInSplit = ev && (ev.altKey || (ev.metaKey && ev.shiftKey));
        if (openInSplit) {
            openScratchFromTab(fileId);
            return;
        }
        openFileInPrimary(fileId);
    };

    window.closeTab = function(fileId) {
        state.openTabs.delete(fileId);
        state.tabOrder = state.tabOrder.filter((id) => id !== fileId);
        
        if (state.activeFileId === fileId) {
            if (state.openTabs.size > 0) {
                openFileInPrimary(Array.from(state.openTabs)[0]);
            } else if (state.files.size > 0) {
                openFileInPrimary(Array.from(state.files.keys())[0]);
            } else {
                state.activeFileId = null;
                document.getElementById('editor-container').innerHTML = '';
                if (state.editorView) { state.editorView.dispose(); state.editorView = null; }
                disableEditorSplit();
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
        updateCopyRestrictedUI();
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
        if (state.editorView) state.editorView.updateOptions({ readOnly: readonly });
        if (state.splitEditor) state.splitEditor.updateOptions({ readOnly: readonly });

        // Add/remove viewer overlay (primary pane only)
        const container = document.getElementById('editor-container');
        if (!container) return;
        const existing = container.querySelector('.viewer-overlay');
        if (readonly && !existing) {
            const overlay = document.createElement('div');
            overlay.className = 'viewer-overlay';
            overlay.textContent = state.allowCollaboratorCopy
                ? 'View only — you can still run code'
                : 'View only — guest copy disabled';
            container.style.position = 'relative';
            container.appendChild(overlay);
        } else if (!readonly && existing) {
            existing.remove();
        } else if (readonly && existing) {
            existing.textContent = state.allowCollaboratorCopy
                ? 'View only — you can still run code'
                : 'View only — guest copy disabled';
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
            stopCodeVisibilityCountdown();
            if (state.socket) { state.socket.disconnect(); state.socket = null; }
            disableEditorSplit();
            if (state.editorView) { state.editorView.dispose(); state.editorView = null; }
            if (state.terminal) { state.terminal.dispose(); state.terminal = null; }
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
                const url = window.location.origin + sessionEditorPath(id);
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
        document.getElementById('run-stdin-input')?.addEventListener('input', persistRunStdin);
        document.getElementById('import-folder-input')?.addEventListener('change', async (e) => {
            const list = e.target.files;
            e.target.value = '';
            if (list && list.length) await importLocalFolder(list);
        });
        document.getElementById('import-files-input')?.addEventListener('change', async (e) => {
            const list = e.target.files;
            e.target.value = '';
            if (list && list.length) await importLocalFolder(list);
        });
        document.getElementById('session-pdf-input')?.addEventListener('change', async (e) => {
            const file = e.target.files && e.target.files[0];
            e.target.value = '';
            if (!file) return;
            try {
                await uploadSessionPdf(file);
            } catch (err) {
                showToast(err.message || 'Document upload failed', 'error');
            }
        });
        document.getElementById('join-policy-select')?.addEventListener('change', (e) => {
            setDefaultJoinRole(e.target.value);
        });
        document.getElementById('copy-policy-toggle')?.addEventListener('change', (e) => {
            setAllowCollaboratorCopy(e.target.checked);
        });
        document.getElementById('code-visibility-toggle')?.addEventListener('change', (e) => {
            const controls = document.getElementById('code-visibility-controls');
            if (controls) controls.style.display = e.target.checked ? '' : 'none';
            if (!e.target.checked) updateGuestCodeVisibility('forever');
        });
        document.getElementById('code-visibility-duration')?.addEventListener('change', (e) => {
            const custom = document.getElementById('code-visibility-custom-minutes');
            if (custom) custom.style.display = e.target.value === 'custom' ? '' : 'none';
        });
        document.getElementById('code-visibility-apply-btn')?.addEventListener('click', () => {
            const minutes = getSelectedVisibilityMinutes();
            if (!minutes) {
                showToast('Choose a duration or enter custom minutes', 'error');
                return;
            }
            document.getElementById('code-visibility-toggle').checked = true;
            updateGuestCodeVisibility('timed', minutes);
        });
        document.getElementById('code-visibility-forever-btn')?.addEventListener('click', () => {
            document.getElementById('code-visibility-toggle').checked = false;
            updateGuestCodeVisibility('forever');
        });
        document.getElementById('code-visibility-restore-btn')?.addEventListener('click', () => {
            updateGuestCodeVisibility('restore');
        });
        document.getElementById('session-access-select')?.addEventListener('change', () => {
            const keyInput = document.getElementById('session-class-key-input');
            const isPublic = document.getElementById('session-access-select')?.value === 'public';
            if (keyInput) keyInput.style.display = isPublic ? 'none' : '';
        });
        document.getElementById('session-access-save-btn')?.addEventListener('click', () => {
            saveSessionAccessSettings(false);
        });
        document.getElementById('session-access-modal-select')?.addEventListener('change', () => {
            const keyGroup = document.getElementById('session-access-modal-key-group');
            const isPublic = document.getElementById('session-access-modal-select')?.value === 'public';
            if (keyGroup) keyGroup.style.display = isPublic ? 'none' : '';
        });
        document.getElementById('session-access-modal-save')?.addEventListener('click', () => {
            saveSessionAccessSettings(true);
        });
        document.getElementById('session-access-modal-cancel')?.addEventListener('click', closeSessionAccessModal);
        document.getElementById('session-access-modal-backdrop')?.addEventListener('click', closeSessionAccessModal);
        document.getElementById('pdf-split-close')?.addEventListener('click', () => togglePdfSplit(false));
        document.getElementById('pdf-open-new-tab')?.addEventListener('click', openSessionPdfInNewTab);
        document.getElementById('pdf-zoom-in')?.addEventListener('click', () => {
            const z = sessionPdfZoom === 'fit' ? 100 : sessionPdfZoom;
            setSessionPdfZoom(z + 25);
        });
        document.getElementById('pdf-zoom-out')?.addEventListener('click', () => {
            const z = sessionPdfZoom === 'fit' ? 100 : sessionPdfZoom;
            setSessionPdfZoom(z - 25);
        });
        document.getElementById('pdf-zoom-fit')?.addEventListener('click', () => setSessionPdfZoom('fit'));

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
                else if (action === 'import-folder') {
                    if (!userCanEditSession()) {
                        showToast('Viewers cannot import folders. Ask the owner for editor access.', 'error');
                        return;
                    }
                    document.getElementById('import-folder-input')?.click();
                }
                else if (action === 'import-github') importGitHubIntoCurrentSession();
                else if (action === 'session-access-settings') {
                    openSessionAccessModal();
                }
                else if (action === 'attach-pdf') {
                    if (!userCanManageSessionSettings()) {
                        showToast('Only the session owner or site admin can attach a PDF', 'error');
                        return;
                    }
                    document.getElementById('session-pdf-input')?.click();
                }
                else if (action === 'remove-pdf') removeSessionPdf();
                else if (action === 'toggle-pdf-split') togglePdfSplit();
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

        // ─── Download active file ───
        document.getElementById('download-active-file-btn')?.addEventListener('click', () => {
            downloadActiveFile();
        });

        // ─── Split Editor ───
        document.getElementById('split-editor-btn')?.addEventListener('click', () => {
            if (!state.editorView) return;
            if (state.splitActive) disableEditorSplit();
            else enableEditorSplit();
        });
        document.getElementById('close-split-pane-btn')?.addEventListener('click', () => {
            disableEditorSplit();
        });
        document.getElementById('split-pane-lang-select')?.addEventListener('change', (e) => {
            setSplitScratchLanguage(e.target.value, true);
        });
        document.getElementById('split-pane-run-btn')?.addEventListener('click', () => {
            runCode({ pane: 'split' });
        });
        document.getElementById('split-pane-download-btn')?.addEventListener('click', () => {
            downloadSplitScratch();
        });
        document.getElementById('run-stdin-split-input')?.addEventListener('input', persistSplitStdin);
        document.getElementById('split-pane-clear-output-btn')?.addEventListener('click', () => {
            const out = document.getElementById('split-pane-output');
            const time = document.getElementById('split-pane-exec-time');
            if (out) out.innerHTML = '';
            if (time) time.textContent = '';
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

        initWorkspaceDragDrop();
        initTabDragReorder();

        if (!window.__codemeshEditorResizeBound) {
            window.__codemeshEditorResizeBound = true;
            window.addEventListener('resize', () => layoutMonacoEditor());
        }
    }

    // ─── Code Execution ───
    async function runCode(options = {}) {
        const pane = options.pane || (state.splitActive && state.focusedPane === 'split' ? 'split' : 'primary');
        const editor = pane === 'split' ? state.splitEditor : state.editorView;
        if (!editor) return;

        const code = editor.getValue();
        const isSplitRun = pane === 'split';
        const language = isSplitRun
            ? state.splitScratch.language
            : (() => {
                const fileId = state.activeFileId;
                const active = fileId && state.files.get(fileId);
                return active ? resolveEditorLanguage(active, code) : 'plaintext';
            })();

        const runLabel = isSplitRun ? getSplitScratchDisplayName() : (state.activeFileId && state.files.get(state.activeFileId)
            ? fileBasename(state.files.get(state.activeFileId).name)
            : 'editor');

        if (!code.trim()) {
            showToast('Nothing to run — editor is empty', 'error');
            return;
        }

        const runBtn = document.getElementById('run-code-btn');
        const splitRunBtn = document.getElementById('split-pane-run-btn');
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

        updateStdinHintForCode(code, pane);
        if (!isSplitRun) ensureRunPanelVisible();
        const stdin = getRunStdin(pane);
        if (codeNeedsStdin(code) && !stdin.trim()) {
            const where = isSplitRun
                ? 'Add input in the stdin box above, then Run again.'
                : 'Add input in the OUTPUT panel below, then Run again.';
            showToast(`This program reads stdin (cin, scanf, input…). ${where}`, 'info');
            if (isSplitRun) document.getElementById('run-stdin-split-input')?.focus();
            else document.getElementById('run-stdin-input')?.focus();
        }

        const outputContent = isSplitRun
            ? document.getElementById('split-pane-output')
            : document.getElementById('output-content');
        const execTimeEl = isSplitRun
            ? document.getElementById('split-pane-exec-time')
            : document.getElementById('exec-time');
        runBtn?.classList.add('running');
        splitRunBtn?.classList.add('running');
        const runBtnSpan = runBtn?.querySelector('span');
        if (runBtnSpan) runBtnSpan.textContent = 'Running...';
        if (outputContent) {
            outputContent.innerHTML = `<span class="output-info">⏳ Running ${escapeHtml(runLabel)} (${escapeHtml(language)})…</span>`;
        }
        if (execTimeEl) execTimeEl.textContent = '';

        if (isSplitRun) persistSplitStdin();
        else persistRunStdin();

        try {
            const result = await api('/run', {
                method: 'POST',
                body: JSON.stringify({ code, language, stdin })
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

            if (outputContent) outputContent.innerHTML = html;
            if (execTimeEl) execTimeEl.textContent = result.execTime ? `${result.execTime}ms` : '';

        } catch (err) {
            if (outputContent) {
                outputContent.innerHTML = `<span class="output-error">Error: ${escapeHtml(err.message)}</span>`;
            }
            if (execTimeEl) execTimeEl.textContent = '';
        } finally {
            runBtn?.classList.remove('running');
            splitRunBtn?.classList.remove('running');
            const runBtnSpan = runBtn?.querySelector('span');
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
                const clashroomsPanel = document.getElementById('admin-clashrooms-panel');
                const filesPanel = document.getElementById('admin-files-panel');
                if (usersPanel) usersPanel.style.display = target === 'users' ? '' : 'none';
                if (sessionsPanel) sessionsPanel.style.display = target === 'sessions' ? '' : 'none';
                if (clashroomsPanel) {
                    clashroomsPanel.style.display = target === 'clashrooms' ? '' : 'none';
                    if (target === 'clashrooms') {
                        loadAdminClashrooms();
                    }
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

        document.getElementById('admin-clashroom-submissions-close')?.addEventListener('click', () => {
            const p = document.getElementById('admin-clashroom-submissions-panel');
            if (p) p.style.display = 'none';
        });

        document.getElementById('admin-clashrooms-panel')?.addEventListener('click', async (e) => {
            const subsBtn = e.target.closest('.admin-clashroom-subs-btn');
            if (subsBtn && subsBtn.dataset.slug) {
                window._adminViewClashroomSubmissions(subsBtn.dataset.slug);
                return;
            }
            const delBtn = e.target.closest('.admin-delete-clashroom');
            if (delBtn && delBtn.dataset.slug) {
                const slug = delBtn.getAttribute('data-slug');
                if (!slug || !confirm('Delete room ' + slug + ' and its submissions?')) return;
                try {
                    await api('/admin/clashrooms/' + encodeURIComponent(slug), { method: 'DELETE' });
                    showToast('Room deleted', 'success');
                    loadAdminClashrooms();
                } catch (err) {
                    showToast(err.message, 'error');
                }
                return;
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
        await Promise.all([loadAdminUsers(), loadAdminSessions(), loadAdminClashrooms(), loadAdminFiles()]);
    }

    async function loadAdminClashrooms() {
        const tbody = document.getElementById('admin-clashrooms-tbody');
        const countEl = document.getElementById('admin-clashroom-count');
        if (!tbody) return;
        try {
            const rows = await api('/admin/clashrooms');
            if (countEl) countEl.textContent = `${rows.length} rooms`;
            tbody.innerHTML = rows.length === 0
                ? '<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:24px;">No clash rooms</td></tr>'
                : rows.map((r) => `
                    <tr>
                        <td><code>${escapeHtml(r.slug)}</code></td>
                        <td>${escapeHtml(r.phase || '—')}</td>
                        <td>${escapeHtml(r.status || '—')}</td>
                        <td>${escapeHtml(r.resolvedMode || '—')}</td>
                        <td>${escapeHtml(r.host || '—')}</td>
                        <td>${r.participantCount != null ? r.participantCount : '—'} / ${r.maxPlayers != null ? r.maxPlayers : ''}</td>
                        <td>${timeAgo(r.createdAt)}</td>
                        <td><div class="admin-actions">
                            <button type="button" class="btn btn-secondary btn-sm admin-clashroom-subs-btn" data-slug="${escapeHtml(r.slug)}">All code</button>
                            <button type="button" class="btn-delete admin-delete-clashroom" data-slug="${escapeHtml(r.slug)}">Delete</button>
                        </div></td>
                    </tr>`).join('');
        } catch (err) {
            if (countEl) countEl.textContent = '—';
            tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:24px;">Failed to load</td></tr>';
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

    window._adminViewClashroomSubmissions = async function (slug) {
        const panel = document.getElementById('admin-clashroom-submissions-panel');
        const pre = document.getElementById('admin-clashroom-submissions-pre');
        const head = document.getElementById('admin-clashroom-submissions-heading');
        if (!panel || !pre) return;
        pre.textContent = 'Loading…';
        panel.style.display = '';
        if (head) head.textContent = 'Submissions: ' + slug;
        try {
            const data = await api('/admin/clashrooms/' + encodeURIComponent(slug) + '/submissions');
            const parts = [];
            parts.push(`# ${data.title || slug} (${data.slug})  mode=${data.mode || ''}  submissions=${data.count}`);
            (data.submissions || []).forEach((s, i) => {
                parts.push('');
                parts.push(`--- #${i + 1} ${s.bestAchievedAt ? new Date(s.bestAchievedAt).toISOString() : (s.lastAttemptAt ? new Date(s.lastAttemptAt).toISOString() : '')} ---`);
                parts.push(`user: ${s.username} <${s.email || ''}>`);
                parts.push(`language: ${s.language}  accepted: ${s.accepted}  bytes: ${s.sourceByteLength}  totalTimeMs: ${s.totalTimeMs}`);
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

    function getClashCodeValue() {
        const ta = document.getElementById('clash-code-input');
        if (clashMonacoEditor) {
            try {
                return clashMonacoEditor.getValue();
            } catch (_) { /* use textarea */ }
        }
        return (ta && ta.value) || '';
    }

    function updateClashCharCounter() {
        const el = document.getElementById('clash-char-counter');
        if (!el) return;
        const n = getClashCodeValue().trim().length;
        el.textContent = `${n} char${n === 1 ? '' : 's'}`;
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
                fontFamily: EDITOR_FONT_FAMILY,
                fontLigatures: false,
                automaticLayout: true,
                minimap: { enabled: false },
                wordWrap: 'on'
            });
            container.style.display = '';
            ta.style.display = 'none';
            clashMonacoEditor.onDidChangeModelContent(() => {
                ta.value = clashMonacoEditor.getValue();
                updateClashCharCounter();
            });
            updateClashCharCounter();
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
            const rows = await api('/clashrooms');
            list.innerHTML = rows.length
                ? rows.map((r) => {
                    const st = escapeHtml(r.status || '—');
                    const ph = escapeHtml(r.phase || '—');
                    return `<li class="clash-li coc-hub-item"><a href="#" class="clash-open" data-slug="${escapeHtml(r.slug)}">${escapeHtml(r.slug)}</a> <span class="coc-aside-muted">${ph}</span> <span class="clash-badge clash-badge-sm">${st}</span></li>`;
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
            list.innerHTML = '<li class="coc-aside-muted">Could not load rooms.</li>';
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
        const runTestsBtn = document.getElementById('clash-run-tests-btn');
        const playground = document.getElementById('clash-playground');
        const shareInput = document.getElementById('clash-share-url-input');
        const liveSub = document.getElementById('clash-live-subtitle');
        const phase = c.phase || '';
        const status = c.status || 'ready';
        const ph = !!c.problemHidden;
        const problemVisible = !ph;
        const matchLive = phase === 'live';
        const matchEnded = phase === 'ended';
        const modeLabel = c.mode || c.resolvedMode || '';

        const showLobby = ['preparing', 'lobby', 'countdown'].includes(phase);
        const langs = (c.allowedLanguages && c.allowedLanguages.length) ? c.allowedLanguages : ['python'];
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
                const langCount = langs.length;
                if (langsEl) {
                    if (c.languagesAll) {
                        langsEl.textContent = `All sandbox (${langCount})`;
                    } else {
                        const preview = langs.slice(0, 5).join(', ');
                        langsEl.textContent = langCount <= 5
                            ? preview
                            : `${preview}… (${langCount} total)`;
                    }
                }
                const slots = document.getElementById('clash-lobby-slots');
                if (slots) slots.innerHTML = buildClashLobbySlotHtml(c.participants, c.maxPlayers);
                const joinBtn = document.getElementById('clash-join-btn');
                if (joinBtn) joinBtn.style.display = c.isOwner ? 'none' : '';
                const asideNote = document.getElementById('clash-lobby-aside-note');
                if (asideNote) {
                    if (c.isOwner) {
                        if (phase === 'preparing' && status === 'verifying') {
                            asideNote.textContent = 'You are the host — countdown starts automatically as soon as verification finishes.';
                        } else {
                            asideNote.textContent = phase === 'countdown'
                                ? 'Countdown is running automatically — use Start now to skip the wait.'
                                : 'Countdown starts automatically when the room is ready.';
                        }
                    } else {
                        asideNote.textContent = phase === 'preparing' && status === 'verifying'
                            ? 'The puzzle is still being prepared — countdown starts automatically when it is ready.'
                            : 'Countdown starts automatically; wait for the puzzle to unlock.';
                    }
                }
                const cdLabel = document.getElementById('clash-lobby-cd-label');
                const cdDigits = document.getElementById('clash-lobby-cd');
                const preCdSec = Math.max(1, Math.floor((c.countdownDurationMs || 300000) / 1000));
                if (phase === 'countdown' && c.countdownEndsAt) {
                    const endMs = new Date(c.countdownEndsAt).getTime();
                    if (cdLabel) cdLabel.textContent = 'Clash starts in';
                    if (!Number.isFinite(endMs)) {
                        if (cdDigits) cdDigits.textContent = '—:—';
                    } else {
                        const startSec = c.countdownSecondsRemaining != null ? c.countdownSecondsRemaining
                            : Math.max(0, Math.floor((endMs - Date.now()) / 1000));
                        if (cdDigits) cdDigits.textContent = formatClashCountdown(startSec);
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
                    }
                } else {
                    if (cdLabel) {
                        cdLabel.textContent = phase === 'preparing' && status === 'verifying'
                            ? 'Countdown length (after verification)'
                            : 'Countdown starts automatically';
                    }
                    if (cdDigits) cdDigits.textContent = formatClashCountdown(preCdSec);
                }
                const cta = document.getElementById('clash-lobby-cta-row');
                const asideCta = document.getElementById('clash-lobby-aside-cta');
                const canStartNow = c.isOwner && status === 'ready' && ['lobby', 'countdown'].includes(phase);
                const ctaHtml = canStartNow
                    ? '<button type="button" class="coc-btn-start-countdown" id="clash-start-btn">Start now</button>'
                    : (c.isOwner && phase === 'preparing' && status === 'verifying'
                        ? '<p class="coc-aside-muted coc-lobby-cta-msg">Verifying puzzle… countdown will start automatically when ready.</p>'
                        : '');
                if (cta) {
                    cta.innerHTML = ctaHtml;
                }
                if (asideCta) {
                    asideCta.innerHTML = canStartNow
                        ? '<button type="button" class="coc-btn-start-countdown" id="clash-start-sidebar-btn">Start now</button>'
                        : ctaHtml;
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
                if (matchEnded) {
                    inner = '<p class="coc-aside-muted">Match ended — leaderboard is below; submissions are closed.</p>';
                } else if (matchLive && c.endsAt) {
                    const left = typeof c.secondsRemaining === 'number' ? c.secondsRemaining : null;
                    inner = `<div class="coc-banner-live-row"><span class="clash-ok">Match live</span><span class="coc-aside-muted">Time left</span> <span id="clash-countdown-display" class="coc-live-timer">${left != null ? formatClashCountdown(left) : '—'}</span></div>`;
                } else if (matchLive && !c.endsAt) {
                    banner.style.display = 'none';
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
                    meta.innerHTML = `<span class="clash-badge">${escapeHtml(phase)}</span> <span class="coc-aside-muted">Private room</span> <code>${escapeHtml(slug)}</code> <span class="clash-badge">${escapeHtml(status)}</span>`;
                } else {
                    meta.innerHTML = `<span class="clash-badge">${escapeHtml(modeLabel)}</span> <span class="coc-aside-muted">${escapeHtml(c.title || '')}</span> <span class="clash-badge">${escapeHtml(phase)}</span> <span class="clash-badge">${escapeHtml(status)}</span>`;
                }
            }
        }

        if (liveSub) {
            if (problemVisible && matchLive && modeLabel) {
                liveSub.style.display = '';
                liveSub.textContent = `${c.title || 'Clash'} · ${modeLabel}`;
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
            const prevLobby = document.getElementById('clash-lobby-lang-select')?.value;
            const prevLang = langSel.value || prevLobby || '';
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
        const lobbyLangEl = document.getElementById('clash-lobby-lang-select');
        const lobbyLangHint = document.getElementById('clash-lobby-lang-hint');
        if (showLobby && lobbyLangEl) {
            lobbyLangEl.innerHTML = langs.map((l) => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join('');
            const preferred = (langSel && langs.includes(langSel.value)) ? langSel.value : langs[0];
            lobbyLangEl.value = preferred;
            if (langSel && preferred) langSel.value = preferred;
            if (lobbyLangHint) {
                lobbyLangHint.textContent = c.languagesAll
                    ? `All ${langs.length} sandbox languages are allowed.`
                    : `${langs.length} language(s) allowed for this room — pick one for your solution.`;
            }
        }

        const canEdit = matchLive && (c.secondsRemaining == null || c.secondsRemaining > 0);
        if (editorBlock) {
            editorBlock.style.display = (matchLive || matchEnded) ? '' : 'none';
        }
        if (submitBtn) {
            submitBtn.style.display = canEdit ? '' : 'none';
        }
        if (runTestsBtn) {
            runTestsBtn.style.display = canEdit ? '' : 'none';
        }
        updateClashCharCounter();

        if (problemVisible && canEdit) {
            if (!clashMonacoEditor) initClashMonacoLive();
        } else {
            disposeClashMonaco();
        }

        if (matchLive && c.endsAt) {
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
        const report = document.getElementById('clash-report-panel');
        if (report) {
            report.style.display = 'none';
            report.innerHTML = '';
        }
        try {
            const c = await api('/clashrooms/' + encodeURIComponent(slug));
            applyClashRoomPayload(slug, c);

            function clashPayloadNeedsPoll(payload) {
                if (!payload || payload.status === 'rejected') return false;
                if (payload.status === 'verifying') return true;
                const phs = payload.phase || '';
                if (payload.problemHidden && ['preparing', 'lobby', 'countdown'].includes(phs)) return true;
                return false;
            }

            if (clashPayloadNeedsPoll(c)) {
                let prevSnap = { status: c.status, problemHidden: !!c.problemHidden, phase: c.phase || '' };
                clashPollInterval = setInterval(async () => {
                    if (currentClashSlug !== slug) return;
                    try {
                        const c2 = await api('/clashrooms/' + encodeURIComponent(slug));
                        applyClashRoomPayload(slug, c2);
                        if (!clashPayloadNeedsPoll(c2)) {
                            clearInterval(clashPollInterval);
                            clashPollInterval = null;
                            if (c2.status === 'rejected') {
                                showToast('Room did not pass review', 'error');
                            } else if (prevSnap.status === 'verifying' && c2.status === 'ready' && c2.isOwner && c2.phase === 'countdown') {
                                showToast('Puzzle validated — countdown started automatically.', 'success');
                            } else if (prevSnap.problemHidden && !c2.problemHidden && c2.phase === 'live') {
                                showToast('Match is live — puzzle unlocked.', 'success');
                            }
                        }
                        prevSnap = { status: c2.status, problemHidden: !!c2.problemHidden, phase: c2.phase || '' };
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
            const body = await api('/clashrooms/' + encodeURIComponent(slug) + '/start-now', { method: 'POST' });
            const msg = body && body.message
                ? body.message
                : 'Match started.';
            showToast(msg, 'success');
            await openClashRoom(slug);
        } catch (err) {
            showToast(err.message || 'Could not start now', 'error');
        }
    }

    async function loadClashLeaderboard(slug) {
        const el = document.getElementById('clash-leaderboard');
        if (!el) return;
        try {
            const data = await api('/clashrooms/' + encodeURIComponent(slug) + '/leaderboard');
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

    function renderClashRunOutput(res, title) {
        const el = document.getElementById('clash-result');
        if (!el) return;
        const rows = (res.testResults || []).map((t) => {
            const name = t.hidden ? `Hidden test #${t.index + 1}` : `Test #${t.index + 1}`;
            const mark = t.pass ? '<span class="clash-ok">PASS</span>' : '<span class="clash-bad">FAIL</span>';
            return `<li>${mark} ${escapeHtml(name)} <span class="clash-muted">${Number(t.timeMs || 0)} ms</span></li>`;
        }).join('');
        let html = `<p><strong>${escapeHtml(title)}</strong> ${res.accepted ? '<span class="clash-ok">All passed</span>' : '<span class="clash-bad">Some failed</span>'}</p>`;
        html += `<p class="clash-muted">Total time ${Number(res.totalTimeMs || 0)} ms · ${Number(res.charCount || 0)} characters</p>`;
        html += rows ? `<ul class="coc-test-result-list">${rows}</ul>` : '';
        (res.failures || []).forEach((f) => {
            html += `<div class="clash-fail"><h4>Test #${f.index + 1}</h4>`;
            if (f.inputPreview) html += `<p class="clash-muted">Input (preview)</p><pre class="clash-io">${escapeHtml(f.inputPreview)}</pre>`;
            html += `<p><strong>Expected</strong></p><pre class="clash-io">${escapeHtml(f.expected)}</pre>`;
            html += `<p><strong>Your output</strong></p><pre class="clash-io">${escapeHtml(f.actual)}</pre>`;
            if (f.stderr) html += `<p><strong>Stderr</strong></p><pre class="clash-io">${escapeHtml(f.stderr)}</pre>`;
            html += '</div>';
        });
        el.style.display = '';
        el.innerHTML = html;
    }

    async function renderClashReport(slug, res) {
        const playground = document.getElementById('clash-playground');
        const report = document.getElementById('clash-report-panel');
        if (!report) return;
        if (playground) playground.style.display = 'none';
        let leaderboard = [];
        try {
            const data = await api('/clashrooms/' + encodeURIComponent(slug) + '/leaderboard');
            leaderboard = data.leaderboard || [];
        } catch (_) { /* report still renders */ }
        const rows = leaderboard.length
            ? leaderboard.map((r) => `<tr><td>${r.rank}</td><td>${escapeHtml(r.username)}</td><td>${Number(r.totalTimeMs || 0)}</td><td>${Number(r.charCount || 0)}</td><td>${escapeHtml(r.language || '')}</td></tr>`).join('')
            : '<tr><td colspan="5" class="coc-aside-muted">No leaderboard rows yet.</td></tr>';
        report.innerHTML = `
            <div class="coc-report-hero">
                <h2 class="coc-report-title">${res.accepted ? 'Accepted' : 'Submitted'}</h2>
                <p>${res.accepted ? 'Your code passed every test.' : 'Your latest submit did not pass all tests.'}</p>
                <p class="coc-report-stats">
                    <span>Time ${Number(res.totalTimeMs || 0)} ms</span>
                    <span>Chars ${Number(res.charCount || 0)}</span>
                    <span>Lang ${escapeHtml(res.language || document.getElementById('clash-lang-select')?.value || '')}</span>
                </p>
            </div>
            <table class="clash-table"><thead><tr><th>#</th><th>User</th><th>Time ms</th><th>Chars</th><th>Lang</th></tr></thead><tbody>${rows}</tbody></table>
            <div class="coc-report-actions">
                <button type="button" class="btn btn-secondary" id="clash-report-back-btn">Back to clash</button>
                <button type="button" class="btn btn-primary" id="clash-report-home-btn">Clash home</button>
            </div>`;
        report.style.display = '';
        report.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    async function runClashTests() {
        const slug = currentClashSlug;
        if (!slug) return;
        const lang = document.getElementById('clash-lang-select')?.value;
        const code = getClashCodeValue();
        if (!code.trim()) {
            showToast('Paste your solution first', 'error');
            return;
        }
        const btn = document.getElementById('clash-run-tests-btn');
        if (btn) btn.disabled = true;
        try {
            const res = await api('/clashrooms/' + encodeURIComponent(slug) + '/run-tests', {
                method: 'POST',
                body: JSON.stringify({ language: lang, code })
            });
            renderClashRunOutput(res, 'Run all tests');
            showToast(res.accepted ? 'All tests passed' : 'Some tests failed', res.accepted ? 'success' : 'info');
        } catch (err) {
            showToast(err.message || 'Run tests failed', 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    function syncClashLangSubsetVisibility() {
        const scope = document.getElementById('clash-lang-scope')?.value || 'all';
        const wrap = document.getElementById('clash-lang-multiselect-wrap');
        if (wrap) wrap.style.display = scope === 'all' ? 'none' : '';
    }

    async function refreshClashCreateLangUi() {
        const sel = document.getElementById('clash-lang-multiselect');
        if (!sel) return;
        try {
            if (!clashSandboxLangsCache || !clashSandboxLangsCache.length) {
                const d = await api('/clashrooms/options/sandbox-languages');
                clashSandboxLangsCache = Array.isArray(d.languages) ? d.languages : [];
            }
            const langs = clashSandboxLangsCache;
            sel.innerHTML = '';
            if (!langs.length) {
                const o = document.createElement('option');
                o.disabled = true;
                o.textContent = 'No sandbox languages from server';
                sel.appendChild(o);
                syncClashLangSubsetVisibility();
                return;
            }
            const defaults = new Set(['python', 'javascript']);
            langs.forEach((l) => {
                const o = document.createElement('option');
                o.value = l;
                o.textContent = l;
                if (defaults.has(l)) o.selected = true;
                sel.appendChild(o);
            });
        } catch (err) {
            sel.innerHTML = '';
            const o = document.createElement('option');
            o.disabled = true;
            o.textContent = err.message || 'Could not load languages';
            sel.appendChild(o);
        }
        syncClashLangSubsetVisibility();
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
            const languagesAll = (document.getElementById('clash-lang-scope')?.value || 'all') === 'all';
            let allowedLanguages;
            if (!languagesAll) {
                const ms = document.getElementById('clash-lang-multiselect');
                allowedLanguages = ms ? Array.from(ms.selectedOptions).map((o) => o.value).filter(Boolean) : [];
                if (!allowedLanguages.length) {
                    if (msg) msg.textContent = 'Pick at least one language in the list (Ctrl/Cmd+click), or choose “All languages”.';
                    showToast('Select at least one allowed language', 'error');
                    return;
                }
            }
            const source = document.getElementById('clash-source')?.value || 'auto';
            const topic = document.getElementById('clash-create-topic')?.value || '';
            const lobbyCountdownMinutes = Number(document.getElementById('clash-lobby-countdown')?.value) || 5;
            const roomDurationMinutes = Number(document.getElementById('clash-create-duration')?.value) || 15;
            const body = {
                allowedModes,
                languagesAll,
                source,
                topic,
                lobbyCountdownMinutes,
                roomDurationMinutes
            };
            if (!languagesAll) body.allowedLanguages = allowedLanguages;
            const r = await api('/clashrooms', {
                method: 'POST',
                body: JSON.stringify(body)
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
        const code = getClashCodeValue();
        if (!code.trim()) {
            showToast('Paste your solution first', 'error');
            return;
        }
        const btn = document.getElementById('clash-submit-btn');
        if (btn) btn.disabled = true;
        try {
            const res = await api('/clashrooms/' + encodeURIComponent(slug) + '/submit', {
                method: 'POST',
                body: JSON.stringify({ language: lang, code })
            });
            if (res.accepted) {
                await renderClashReport(slug, { ...res, language: lang });
            } else {
                renderClashRunOutput(res, 'Submit');
            }
            showToast(res.accepted ? 'Accepted!' : 'Try again', res.accepted ? 'success' : 'info');
            await loadClashLeaderboard(slug);
        } catch (err) {
            showToast(err.message || 'Submit failed', 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    async function joinClashRoom() {
        const slug = currentClashSlug;
        if (!slug) return;
        try {
            await api('/clashrooms/' + encodeURIComponent(slug) + '/join', { method: 'POST', body: JSON.stringify({}) });
            showToast('You joined the room', 'success');
            await openClashRoom(slug);
        } catch (err) {
            showToast(err.message || 'Join failed — use a registered account', 'error');
        }
    }

    function initClashUi() {
        document.getElementById('clash-open-create-modal')?.addEventListener('click', () => {
            setClashCreateModalOpen(true);
            refreshClashCreateLangUi().catch(() => {});
        });
        document.getElementById('clash-lang-scope')?.addEventListener('change', () => { syncClashLangSubsetVisibility(); });
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
        document.getElementById('clash-leave-room-btn')?.addEventListener('click', async (e) => {
            e.preventDefault();
            const slug = currentClashSlug;
            if (slug && state.token) {
                try {
                    await api('/clashrooms/' + encodeURIComponent(slug) + '/leave', {
                        method: 'POST',
                        body: JSON.stringify({})
                    });
                } catch (_) { /* still return to hub */ }
            }
            history.pushState({}, '', clashHubPath());
            await openClashHub();
        });
        document.getElementById('clash-submit-btn')?.addEventListener('click', () => { submitClash(); });
        document.getElementById('clash-run-tests-btn')?.addEventListener('click', () => { runClashTests(); });
        document.getElementById('clash-code-input')?.addEventListener('input', () => { updateClashCharCounter(); });
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
            if (e.target.closest('#clash-join-btn')) {
                e.preventDefault();
                joinClashRoom();
                return;
            }
            if (e.target.closest('#clash-start-btn, #clash-start-sidebar-btn')) {
                e.preventDefault();
                startClash();
            }
        });
        document.getElementById('clash-report-panel')?.addEventListener('click', (e) => {
            if (e.target.closest('#clash-report-back-btn')) {
                e.preventDefault();
                if (currentClashSlug) openClashRoom(currentClashSlug);
                return;
            }
            if (e.target.closest('#clash-report-home-btn')) {
                e.preventDefault();
                history.pushState({}, '', clashHubPath());
                openClashHub();
            }
        });
        document.getElementById('clash-lobby-lang-select')?.addEventListener('change', () => {
            const lobby = document.getElementById('clash-lobby-lang-select');
            const main = document.getElementById('clash-lang-select');
            if (!lobby || !main || !lobby.value) return;
            main.value = lobby.value;
            if (clashMonacoEditor && window.monaco) {
                try {
                    window.monaco.editor.setModelLanguage(
                        clashMonacoEditor.getModel(),
                        mapLanguageToMonaco(main.value)
                    );
                } catch (_) { /* ignore */ }
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
        initPaneResizers();
        initDocAnnotate();
        initDocxTextEditing();
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
