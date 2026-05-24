const express = require('express');
const authMiddleware = require('../middleware/auth');
const { executeCodeWithStdin, DEFAULT_TIMEOUT_MS } = require('../utils/sandboxRun');

const router = express.Router();

// POST /api/run — no stdin (interactive playground)
router.post('/', authMiddleware, async (req, res) => {
    const { code, language, stdin } = req.body;

    if (!code || !language) {
        return res.status(400).json({ error: 'Code and language are required' });
    }

    const stdinText = stdin != null ? String(stdin) : '';
    const stdinCapped = stdinText.length > 100000 ? stdinText.slice(0, 100000) : stdinText;

    try {
        const r = await executeCodeWithStdin({
            code,
            language,
            stdin: stdinCapped,
            timeLimitMs: DEFAULT_TIMEOUT_MS
        });

        if (!r.ok && r.stage === 'validate') {
            return res.status(400).json({ error: r.error });
        }

        if (!r.ok) {
            return res.json({
                output: r.stdout || '',
                error: r.stderr || r.error || '',
                exitCode: r.code != null ? r.code : 1,
                timedOut: !!r.timedOut,
                execTime: r.execTimeMs || 0,
                stage: r.stage || 'run'
            });
        }

        res.json({
            output: r.stdout || '',
            error: r.stderr || '',
            exitCode: r.code,
            timedOut: r.timedOut,
            execTime: r.execTimeMs,
            stage: r.stage || 'run'
        });
    } catch (err) {
        console.error('Code execution error:', err);
        res.status(500).json({ error: 'Execution failed: ' + err.message });
    }
});

module.exports = router;
