const express = require('express');
const { exec } = require('child_process');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

const TIMEOUT_MS = 5000;
const ALLOWED = ['node', 'python3', 'python', 'npm', 'npx', 'ls', 'pwd', 'echo', 'cat', 'clear', 'whoami', 'date'];

function isAllowed(cmd) {
    const first = (cmd.trim().split(/\s+/)[0] || '').toLowerCase();
    return ALLOWED.includes(first);
}

// POST /api/terminal/exec
router.post('/exec', authMiddleware, (req, res) => {
    const { command } = req.body;
    if (!command || typeof command !== 'string') {
        return res.status(400).json({ output: '', error: 'Command required' });
    }
    if (!isAllowed(command)) {
        return res.json({ output: '', error: `Command not allowed. Allowed: ${ALLOWED.join(', ')}` });
    }
    exec(command, { timeout: TIMEOUT_MS, maxBuffer: 50000 }, (err, stdout, stderr) => {
        if (err && err.killed) {
            return res.json({ output: (stdout || '') + (stderr || ''), error: 'Timed out' });
        }
        const out = (stdout || '') + (stderr || '');
        res.json({ output: out, error: err ? err.message : '' });
    });
});

module.exports = router;
