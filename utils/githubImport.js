/**
 * Fetch file list + contents from a public GitHub repo (Git Trees + Blobs API).
 * Optional GITHUB_TOKEN env raises rate limits and allows some private repos the token can read.
 */

const path = require('path');
const { v4: uuidv4 } = require('uuid');

const GH_API = 'https://api.github.com';

const MAX_FILES = 45;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

const ALLOW_EXT = new Set([
    '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.html', '.htm', '.css', '.scss', '.less',
    '.json', '.md', '.markdown', '.txt', '.py', '.java', '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp', '.xhtml',
    '.go', '.rs', '.php', '.rb', '.yml', '.yaml', '.sql', '.sh', '.bash', '.xml', '.svg', '.vue', '.svelte'
]);

function ghHeaders() {
    const h = {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'CodeMesh-Import',
        'X-GitHub-Api-Version': '2022-11-28'
    };
    if (process.env.GITHUB_TOKEN) {
        h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    return h;
}

async function ghJson(apiPath) {
    const res = await fetch(GH_API + apiPath, { headers: ghHeaders() });
    const text = await res.text();
    if (!res.ok) {
        let msg = text.slice(0, 240);
        try {
            const j = JSON.parse(text);
            if (j.message) msg = j.message;
        } catch (_) { /* ignore */ }
        const err = new Error(msg || `GitHub HTTP ${res.status}`);
        err.status = res.status;
        throw err;
    }
    return JSON.parse(text);
}

function shouldSkipPath(p) {
    const lower = p.toLowerCase();
    const parts = lower.split('/');
    for (const seg of parts) {
        if (seg.startsWith('.')) return true;
        if (seg === 'node_modules' || seg === 'dist' || seg === 'build' || seg === 'vendor'
            || seg === '.next' || seg === '__pycache__' || seg === 'coverage' || seg === '.cache'
            || seg === 'pods' || seg === '.git') return true;
    }
    if (lower.includes('package-lock.json') || lower.includes('yarn.lock') || lower.includes('pnpm-lock')) return true;
    return false;
}

function textLikeFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ALLOW_EXT.has(ext)) return true;
    const base = path.basename(filePath).toLowerCase();
    const noExtOk = new Set([
        'readme', 'license', 'contributing', 'changelog', 'code_of_conduct',
        'dockerfile', 'makefile', 'gemfile', 'rakefile', 'procfile'
    ]);
    if (!ext && noExtOk.has(base)) return true;
    return base === 'dockerfile' || base === 'makefile' || base === 'gemfile' || base === 'rakefile';
}

function languageFromFilename(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const map = {
        '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
        '.ts': 'typescript', '.tsx': 'typescript',
        '.html': 'html', '.htm': 'html', '.xhtml': 'html',
        '.css': 'css', '.scss': 'scss', '.less': 'less',
        '.py': 'python',
        '.java': 'java',
        '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp',
        '.c': 'c', '.h': 'c',
        '.go': 'go',
        '.rs': 'rust',
        '.php': 'php',
        '.rb': 'ruby',
        '.sql': 'sql',
        '.md': 'markdown', '.markdown': 'markdown',
        '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
        '.xml': 'xml',
        '.sh': 'shell', '.bash': 'shell',
        '.vue': 'html', '.svelte': 'html', '.svg': 'xml'
    };
    return map[ext] || 'plaintext';
}

function pathSortScore(p) {
    const pl = p.toLowerCase();
    if (pl === 'index.html' || pl.endsWith('/index.html')) return 0;
    if (pl.endsWith('.html') || pl.endsWith('.htm')) return 1;
    return 2 + p.split('/').length;
}

/**
 * @param {string} repoSpec - "owner/name"
 * @param {string} [branchOpt]
 * @returns {Promise<{ files: Array<{id,name,content,language}>, truncated: boolean, branch: string }>}
 */
async function fetchPublicRepoFiles(repoSpec, branchOpt) {
    const trimmed = String(repoSpec || '').trim();
    const m = trimmed.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/);
    if (!m) {
        throw new Error('Use format owner/repo (e.g. octocat/Hello-World). Public repos only unless GITHUB_TOKEN is set.');
    }
    const owner = m[1];
    const repo = m[2];

    const repoInfo = await ghJson(`/repos/${owner}/${repo}`);
    const branch = (branchOpt && String(branchOpt).trim()) || repoInfo.default_branch;

    let bref;
    try {
        bref = await ghJson(`/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`);
    } catch (e) {
        if (e.status === 404) throw new Error(`Branch not found: ${branch}`);
        throw e;
    }
    const sha = bref.commit.sha;
    const tree = await ghJson(`/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`);
    if (!tree.tree || !Array.isArray(tree.tree)) {
        throw new Error('Empty or unreadable repository tree');
    }

    const candidates = tree.tree.filter((t) => (
        t.type === 'blob'
        && t.path
        && typeof t.size === 'number'
        && t.size > 0
        && t.size <= MAX_FILE_BYTES
        && !shouldSkipPath(t.path)
        && textLikeFile(t.path)
    ));

    candidates.sort((a, b) => {
        const d = pathSortScore(a.path) - pathSortScore(b.path);
        if (d !== 0) return d;
        return a.path.localeCompare(b.path);
    });

    const files = [];
    let totalBytes = 0;
    const truncatedTree = !!tree.truncated;

    for (const item of candidates) {
        if (files.length >= MAX_FILES) break;
        const blobJson = await ghJson(`/repos/${owner}/${repo}/git/blobs/${item.sha}`);
        if (!blobJson.content || blobJson.encoding !== 'base64') continue;

        const buf = Buffer.from(blobJson.content.replace(/\n/g, ''), 'base64');
        if (buf.length > MAX_FILE_BYTES) continue;
        if (buf.includes(0)) continue;

        let text;
        try {
            text = buf.toString('utf8');
        } catch (_) {
            continue;
        }

        if (totalBytes + text.length > MAX_TOTAL_BYTES) break;
        totalBytes += text.length;

        files.push({
            id: 'f_' + uuidv4().split('-')[0],
            name: item.path.replace(/\\/g, '/'),
            content: text,
            language: languageFromFilename(item.path)
        });
    }

    return { files, truncated: truncatedTree, branch };
}

module.exports = { fetchPublicRepoFiles };
