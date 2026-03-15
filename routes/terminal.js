const express = require('express');
const { exec } = require('child_process');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// ─── Security: Terminal disabled by default in production ───
const TERMINAL_ENABLED = process.env.ENABLE_TERMINAL === 'true' || process.env.NODE_ENV !== 'production';

const TIMEOUT_MS = 5000;
// ─── Safe commands only (removed npm, npx, cat for security) ───
const ALLOWED = ['node', 'python3', 'python', 'ls', 'pwd', 'echo', 'clear', 'whoami', 'date'];

function isAllowed(cmd) {
    if (!cmd || typeof cmd !== 'string') return false;
    const trimmed = cmd.trim();
    if (!trimmed) return false;
    
    // Split command and arguments
    const parts = trimmed.split(/\s+/);
    const command = parts[0].toLowerCase();
    
    // Only allow whitelisted commands
    if (!ALLOWED.includes(command)) return false;
    
    // Block dangerous patterns
    const dangerous = ['&&', '||', ';', '|', '>', '<', '`', '$', '(', ')', '{', '}'];
    if (dangerous.some(pattern => trimmed.includes(pattern))) return false;
    
    // Block attempts to access sensitive paths
    const sensitivePaths = ['/etc', '/root', '/home', '.env', 'passwd', 'shadow'];
    if (sensitivePaths.some(path => trimmed.toLowerCase().includes(path))) return false;
    
    return true;
}

// GET /api/terminal/status - Check if terminal is enabled
router.get('/status', (req, res) => {
    res.json({ enabled: TERMINAL_ENABLED, allowed: TERMINAL_ENABLED ? ALLOWED : [] });
});

// POST /api/terminal/exec
router.post('/exec', authMiddleware, (req, res) => {
    if (!TERMINAL_ENABLED) {
        return res.status(403).json({ 
            output: '', 
            error: 'Terminal is disabled for security. Set ENABLE_TERMINAL=true in production to enable (not recommended).' 
        });
    }
    
    const { command } = req.body;
    if (!command || typeof command !== 'string') {
        return res.status(400).json({ output: '', error: 'Command required' });
    }
    
    if (!isAllowed(command)) {
        return res.json({ 
            output: '', 
            error: `Command not allowed or contains dangerous characters. Allowed: ${ALLOWED.join(', ')}` 
        });
    }
    
    exec(command, { 
        timeout: TIMEOUT_MS, 
        maxBuffer: 50000,
        // Run in a restricted environment
        env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin' }
    }, (err, stdout, stderr) => {
        if (err && err.killed) {
            return res.json({ output: (stdout || '') + (stderr || ''), error: 'Timed out' });
        }
        const out = (stdout || '') + (stderr || '');
        res.json({ output: out, error: err ? err.message : '' });
    });
});

module.exports = router;
