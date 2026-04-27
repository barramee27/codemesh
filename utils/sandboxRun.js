/**
 * Sandboxed program execution (shared by /api/run and grader).
 * Supports optional stdin per run; compile step unchanged.
 */

const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_OUTPUT = 50000;

const RUNNERS = {
    javascript: {
        ext: '.js',
        cmd: (file) => ['node', ['--max-old-space-size=128', file]]
    },
    python: {
        ext: '.py',
        cmd: (file) => ['python3', ['-u', file]],
        cmdFallback: (file) => ['python', ['-u', file]]
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

/**
 * @param {string} command
 * @param {string[]} args
 * @param {number} timeoutMs
 * @param {string|null} stdinData - if null/undefined, stdin is closed immediately (compile / no-input run)
 */
function runProcess(command, args, timeoutMs, stdinData) {
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

        if (stdinData != null && stdinData !== '') {
            proc.stdin.write(stdinData, 'utf8', () => {
                proc.stdin.end();
            });
        } else {
            proc.stdin.end();
        }
    });
}

/** Normalize stdout for grader comparison: CRLF -> LF, trim trailing whitespace on last line only per spec */
function normalizeProgramOutput(s) {
    if (s == null) return '';
    let t = String(s).replace(/\r\n/g, '\n');
    t = t.replace(/\r/g, '\n');
    return t.replace(/\s+$/u, '');
}

/**
 * Full write-compile-run-clean for one stdin payload. Returns exec wall time for the run step only.
 */
async function executeCodeWithStdin({ code, language, stdin, timeLimitMs = DEFAULT_TIMEOUT_MS }) {
    const runner = RUNNERS[language];
    if (!runner) {
        return { ok: false, error: `Language "${language}" is not supported`, stage: 'validate', stdout: '', stderr: '' };
    }

    const tmpDir = path.join(os.tmpdir(), 'codemesh-' + uuidv4());
    await fs.mkdir(tmpDir, { recursive: true });

    const fileName = language === 'java' ? 'Main.java' : `main${runner.ext}`;
    const filePath = path.join(tmpDir, fileName);
    const outPath = path.join(tmpDir, 'main_out');

    try {
        let processedCode = code;
        if (language === 'java' && !code.includes('class Main')) {
            processedCode = `public class Main {\n${code}\n}`;
        }

        await fs.writeFile(filePath, processedCode);

        if (runner.compile) {
            const [compCmd, compArgs] = runner.compile(filePath, outPath);
            const compResult = await runProcess(compCmd, compArgs, timeLimitMs, null);
            if (compResult.code !== 0) {
                return {
                    ok: false,
                    stdout: '',
                    stderr: compResult.stderr || 'Compilation failed',
                    code: compResult.code,
                    timedOut: compResult.timedOut,
                    stage: 'compile',
                    execTimeMs: 0
                };
            }
        }

        let [runCmd, runArgs] = runner.cmd(filePath, outPath);
        const start = Date.now();
        let result = await runProcess(runCmd, runArgs, timeLimitMs, stdin == null ? '' : stdin);
        if (language === 'python' && runner.cmdFallback && result.stderr && result.stderr.includes('spawn python3 ENOENT')) {
            [runCmd, runArgs] = runner.cmdFallback(filePath, outPath);
            result = await runProcess(runCmd, runArgs, timeLimitMs, stdin == null ? '' : stdin);
        }
        const execTimeMs = Date.now() - start;

        if (language === 'python' && result.stderr && (result.stderr.includes('spawn python3 ENOENT') || result.stderr.includes('spawn python ENOENT'))) {
            return {
                ok: false,
                stdout: '',
                stderr: 'Python is not installed on this server.',
                code: 1,
                timedOut: false,
                stage: 'run',
                execTimeMs
            };
        }

        return {
            ok: true,
            stdout: result.stdout,
            stderr: result.stderr,
            code: result.code,
            timedOut: result.timedOut,
            stage: 'run',
            execTimeMs
        };
    } catch (err) {
        return { ok: false, error: err.message, stage: 'exception', stdout: '', stderr: err.message };
    } finally {
        try {
            await fs.rm(tmpDir, { recursive: true, force: true });
        } catch (e) {
            console.error('sandboxRun cleanup:', e.message);
        }
    }
}

function listRunnerLanguages() {
    return Object.keys(RUNNERS);
}

module.exports = {
    RUNNERS,
    DEFAULT_TIMEOUT_MS,
    MAX_OUTPUT,
    runProcess,
    normalizeProgramOutput,
    executeCodeWithStdin,
    listRunnerLanguages
};
