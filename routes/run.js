const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

const TIMEOUT_MS = 10000; // 10 second max execution
const MAX_OUTPUT = 50000; // 50KB max output

// Supported languages and their execution commands
const RUNNERS = {
    javascript: {
        ext: '.js',
        cmd: (file) => ['node', ['--max-old-space-size=128', file]]
    },
    python: {
        ext: '.py',
        cmd: (file) => ['python3', ['-u', file]],
        cmdFallback: (file) => ['python', ['-u', file]]  // Fallback when python3 not found
    },
    typescript: {
        ext: '.ts',
        cmd: (file) => ['node', ['--max-old-space-size=128', '--experimental-strip-types', file]]
    },
    cpp: {
        ext: '.cpp',
        compile: (file, out) => ['g++', ['-o', out, file, '-std=c++17']],
        cmd: (file, out) => [out, []]
    },
    java: {
        ext: '.java',
        compile: (file, out) => ['javac', [file]],
        cmd: (file, out) => {
            const dir = path.dirname(file);
            const className = path.basename(file, '.java');
            return ['java', ['-cp', dir, className]];
        }
    },
    csharp: {
        ext: '.cs',
        cmd: (file) => ['dotnet-script', [file]]
    },
    go: {
        ext: '.go',
        cmd: (file) => ['go', ['run', file]]
    },
    rust: {
        ext: '.rs',
        compile: (file, out) => ['rustc', ['-o', out, file]],
        cmd: (file, out) => [out, []]
    },
    php: {
        ext: '.php',
        cmd: (file) => ['php', [file]]
    },
    ruby: {
        ext: '.rb',
        cmd: (file) => ['ruby', [file]]
    }
};

function runProcess(command, args, timeoutMs) {
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let killed = false;

        const proc = spawn(command, args, {
            timeout: timeoutMs,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, NODE_ENV: 'sandbox' }
        });

        proc.stdout.on('data', (data) => {
            stdout += data.toString();
            if (stdout.length > MAX_OUTPUT) {
                stdout = stdout.slice(0, MAX_OUTPUT) + '\n... [output truncated]';
                proc.kill();
                killed = true;
            }
        });

        proc.stderr.on('data', (data) => {
            stderr += data.toString();
            if (stderr.length > MAX_OUTPUT) {
                stderr = stderr.slice(0, MAX_OUTPUT) + '\n... [output truncated]';
                proc.kill();
                killed = true;
            }
        });

        proc.on('close', (code, signal) => {
            if (signal === 'SIGTERM' || killed) {
                resolve({ stdout, stderr: stderr || 'Execution timed out or output too large', code: 1, timedOut: true });
            } else {
                resolve({ stdout, stderr, code: code || 0, timedOut: false });
            }
        });

        proc.on('error', (err) => {
            resolve({ stdout: '', stderr: `Failed to start: ${err.message}`, code: 1, timedOut: false });
        });

        // Close stdin immediately
        proc.stdin.end();
    });
}

// POST /api/run
router.post('/', authMiddleware, async (req, res) => {
    const { code, language } = req.body;

    if (!code || !language) {
        return res.status(400).json({ error: 'Code and language are required' });
    }

    const runner = RUNNERS[language];
    if (!runner) {
        return res.status(400).json({ error: `Language "${language}" is not supported for execution` });
    }

    // Create temp file
    const tmpDir = path.join(os.tmpdir(), 'codemesh-' + uuidv4());
    fs.mkdirSync(tmpDir, { recursive: true });

    const fileName = language === 'java' ? 'Main.java' : `main${runner.ext}`;
    const filePath = path.join(tmpDir, fileName);
    const outPath = path.join(tmpDir, 'main_out');

    try {
        // For Java, wrap code in class if it doesn't have one
        let processedCode = code;
        if (language === 'java' && !code.includes('class Main')) {
            processedCode = `public class Main {\n${code}\n}`;
        }

        fs.writeFileSync(filePath, processedCode);

        // Compile step (if needed)
        if (runner.compile) {
            const [compCmd, compArgs] = runner.compile(filePath, outPath);
            const compResult = await runProcess(compCmd, compArgs, TIMEOUT_MS);
            if (compResult.code !== 0) {
                return res.json({
                    output: '',
                    error: compResult.stderr || 'Compilation failed',
                    exitCode: compResult.code,
                    stage: 'compile'
                });
            }
        }

        // Run (with fallback for Python when python3 not found)
        let [runCmd, runArgs] = runner.cmd(filePath, outPath);
        const startTime = Date.now();
        let result = await runProcess(runCmd, runArgs, TIMEOUT_MS);

        if (language === 'python' && runner.cmdFallback && result.stderr && result.stderr.includes('spawn python3 ENOENT')) {
            [runCmd, runArgs] = runner.cmdFallback(filePath, outPath);
            result = await runProcess(runCmd, runArgs, TIMEOUT_MS);
        }

        // Python not installed (Railway, etc.) — return helpful message
        if (language === 'python' && result.stderr && (result.stderr.includes('spawn python3 ENOENT') || result.stderr.includes('spawn python ENOENT'))) {
            result = {
                stdout: '',
                stderr: 'Python is not installed on this server. To run Python code, add Python to your deployment (e.g. Railway: add a nixpacks.toml or use a Python buildpack). JavaScript and HTML preview work without extra setup.',
                code: 1,
                timedOut: false
            };
        }

        const execTime = Date.now() - startTime;

        res.json({
            output: result.stdout,
            error: result.stderr,
            exitCode: result.code,
            timedOut: result.timedOut,
            execTime,
            stage: 'run'
        });
    } catch (err) {
        console.error('Code execution error:', err);
        res.status(500).json({ error: 'Execution failed: ' + err.message });
    } finally {
        // Cleanup temp files
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch { }
    }
});

module.exports = router;
