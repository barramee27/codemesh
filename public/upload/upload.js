(function () {
  const TOKEN_KEY = 'codemesh_token';
  const USER_KEY = 'codemesh_user';

  const authPanel = document.getElementById('auth-panel');
  const deniedPanel = document.getElementById('denied-panel');
  const uploadPanel = document.getElementById('upload-panel');
  const headerUser = document.getElementById('header-user');
  const loginForm = document.getElementById('login-form');
  const loginError = document.getElementById('login-error');
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  const pickBtn = document.getElementById('pick-files-btn');
  const queueEl = document.getElementById('upload-queue');
  const filesList = document.getElementById('files-list');
  const filesEmpty = document.getElementById('files-empty');
  const filesLoading = document.getElementById('files-loading');
  const maxMbLabel = document.getElementById('max-mb-label');
  const rowTemplate = document.getElementById('file-row-template');

  let maxMb = 150;

  function token() {
    return localStorage.getItem(TOKEN_KEY);
  }

  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (token()) headers.Authorization = `Bearer ${token()}`;
    if (options.body && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(`/api${path}`, { ...options, headers });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text || res.statusText };
    }
    if (!res.ok) {
      const msg = data?.error || data?.message || `Request failed (${res.status})`;
      throw new Error(msg);
    }
    return data;
  }

  function formatBytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i += 1;
    }
    return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
  }

  function formatDate(d) {
    if (!d) return '';
    try {
      return new Date(d).toLocaleString();
    } catch {
      return d;
    }
  }

  function showView(view) {
    authPanel.classList.toggle('hidden', view !== 'auth');
    deniedPanel.classList.toggle('hidden', view !== 'denied');
    uploadPanel.classList.toggle('hidden', view !== 'upload');
  }

  function setHeaderUser(user) {
    if (!user) {
      headerUser.classList.add('hidden');
      return;
    }
    headerUser.classList.remove('hidden');
    headerUser.innerHTML = `<strong>${escapeHtml(user.username)}</strong><br>${escapeHtml(user.email)}`;
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  async function bootstrap() {
    if (!token()) {
      showView('auth');
      return;
    }

    try {
      const me = await api('/upload/me');
      setHeaderUser(me.user);
      maxMb = me.maxMb || 150;
      maxMbLabel.textContent = String(maxMb);

      if (!me.canUpload) {
        showView('denied');
        return;
      }

      if (!me.gcsConfigured) {
        loginError.textContent = 'Server GCS is not configured. Ask admin to set GCS_BUCKET_NAME.';
        loginError.classList.remove('hidden');
        showView('auth');
        return;
      }

      showView('upload');
      await loadFiles();
    } catch (err) {
      clearSession();
      showView('auth');
      loginError.textContent = err.message || 'Session expired. Sign in again.';
      loginError.classList.remove('hidden');
    }
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.classList.add('hidden');
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const btn = document.getElementById('login-btn');
    btn.disabled = true;
    btn.textContent = 'Signing in…';

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');

      localStorage.setItem(TOKEN_KEY, data.token);
      localStorage.setItem(USER_KEY, JSON.stringify(data.user));
      await bootstrap();
    } catch (err) {
      loginError.textContent = err.message;
      loginError.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });

  function logout() {
    clearSession();
    setHeaderUser(null);
    showView('auth');
    loginForm.reset();
  }

  document.getElementById('logout-btn').addEventListener('click', logout);
  document.getElementById('logout-denied-btn').addEventListener('click', logout);
  document.getElementById('refresh-files-btn').addEventListener('click', () => loadFiles());

  pickBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.length) uploadFiles(fileInput.files);
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((ev) => {
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
    });
  });
  dropZone.addEventListener('drop', (e) => {
    if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
  });

  function addQueueItem(name) {
    queueEl.classList.remove('hidden');
    const el = document.createElement('div');
    el.className = 'queue-item';
    el.innerHTML = `
      <span class="name">${escapeHtml(name)}</span>
      <div class="progress-bar"><span></span></div>
      <span class="status">Uploading…</span>
    `;
    queueEl.prepend(el);
    return el;
  }

  async function uploadOne(file) {
    const maxBytes = maxMb * 1024 * 1024;
    if (file.size > maxBytes) {
      throw new Error(`Too large (${formatBytes(file.size)}). Max ${maxMb} MB.`);
    }

    const row = addQueueItem(file.name);
    const bar = row.querySelector('.progress-bar span');
    const status = row.querySelector('.status');

  const fd = new FormData();
    fd.append('file', file);

    const xhr = new XMLHttpRequest();
    return new Promise((resolve, reject) => {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          bar.style.width = `${Math.round((e.loaded / e.total) * 100)}%`;
        }
      });
      xhr.addEventListener('load', () => {
        let data = {};
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          /* ignore */
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          row.classList.add('done');
          status.textContent = 'Done';
          bar.style.width = '100%';
          resolve(data);
        } else {
          row.classList.add('fail');
          status.textContent = data.error || `Failed (${xhr.status})`;
          reject(new Error(data.error || 'Upload failed'));
        }
      });
      xhr.addEventListener('error', () => {
        row.classList.add('fail');
        status.textContent = 'Network error';
        reject(new Error('Network error'));
      });
      xhr.open('POST', '/api/upload');
      xhr.setRequestHeader('Authorization', `Bearer ${token()}`);
      xhr.send(fd);
    });
  }

  async function uploadFiles(fileList) {
    for (const file of fileList) {
      try {
        await uploadOne(file);
      } catch (err) {
        console.error(err);
      }
    }
    await loadFiles();
  }

  async function loadFiles() {
    filesLoading.classList.remove('hidden');
    filesEmpty.classList.add('hidden');
    filesList.innerHTML = '';

    try {
      const files = await api('/upload/files');
      filesLoading.classList.add('hidden');

      if (!files.length) {
        filesEmpty.classList.remove('hidden');
        return;
      }

      files.forEach((f) => {
        const li = rowTemplate.content.cloneNode(true);
        const row = li.querySelector('.file-row');
        row.querySelector('.file-name').textContent = f.name;
        row.querySelector('.file-sub').textContent = `${formatBytes(f.size)} · ${formatDate(f.uploadedAt)}`;
        const open = row.querySelector('.open-url-btn');
        open.href = f.url;
        row.querySelector('.copy-url-btn').addEventListener('click', async () => {
          await navigator.clipboard.writeText(f.url);
          row.querySelector('.copy-url-btn').textContent = 'Copied!';
          setTimeout(() => {
            row.querySelector('.copy-url-btn').textContent = 'Copy URL';
          }, 1500);
        });
        row.querySelector('.delete-file-btn').addEventListener('click', async () => {
          if (!confirm(`Delete ${f.name}?`)) return;
          try {
            await api(`/upload/files/${encodeURIComponent(f.name)}`, { method: 'DELETE' });
            row.remove();
            if (!filesList.children.length) filesEmpty.classList.remove('hidden');
          } catch (err) {
            alert(err.message);
          }
        });
        filesList.appendChild(li);
      });
    } catch (err) {
      filesLoading.textContent = err.message || 'Failed to load files';
    }
  }

  bootstrap();
})();
