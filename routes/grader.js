const express = require('express');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const authMiddleware = require('../middleware/auth');
const optionalAuth = require('../middleware/optionalAuth');
const Clash = require('../models/Clash');
const ClashSubmission = require('../models/ClashSubmission');
const { generateClash, verifyClashProblem, flashModelId, proModelId } = require('../utils/geminiClash');
const { executeCodeWithStdin, normalizeProgramOutput } = require('../utils/sandboxRun');

const router = express.Router();

const ROOM_DURATION_PRESETS_MS = {
    5: 5 * 60 * 1000,
    10: 10 * 60 * 1000,
    15: 15 * 60 * 1000,
    30: 30 * 60 * 1000,
    60: 60 * 60 * 1000
};

const aiCreateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 6,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many AI clash creations; try again in a minute' }
});

const submitLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many submissions; try again in a minute' }
});

function makeSlug() {
    return 'c' + crypto.randomBytes(4).toString('hex');
}

function truncate(s, n) {
    const t = String(s || '');
    if (t.length <= n) return t;
    return t.slice(0, n) + '\n… [truncated]';
}

/** Legacy rows have no status → treat as always-open live clash (no room timer). */
function effectiveStatus(clash) {
    if (!clash.status) return 'live';
    return clash.status;
}

function resolveRoomDurationMs(body) {
    const m = Number(body.roomDurationMinutes);
    if (ROOM_DURATION_PRESETS_MS[m]) return ROOM_DURATION_PRESETS_MS[m];
    return ROOM_DURATION_PRESETS_MS[15];
}

async function maybeCloseExpired(clash) {
    if (clash.status === 'live' && clash.endsAt && new Date() >= new Date(clash.endsAt)) {
        await Clash.updateOne({ _id: clash._id }, { $set: { status: 'ended', updatedAt: new Date() } });
        clash.status = 'ended';
    }
    return clash;
}

async function runProVerification(clashId) {
    const clash = await Clash.findById(clashId);
    if (!clash || clash.status !== 'verifying') return;

    const proModel = proModelId();
    try {
        const verdict = await verifyClashProblem({
            mode: clash.mode,
            title: clash.title,
            statement: clash.statement,
            samples: clash.samples,
            tests: clash.tests,
            modelId: proModel
        });

        if (verdict.approved) {
            await Clash.findOneAndUpdate(
                { _id: clashId, status: 'verifying' },
                { $set: { status: 'ready', aiReviewerModel: proModel, updatedAt: new Date() } }
            );
        } else {
            await Clash.findOneAndUpdate(
                { _id: clashId, status: 'verifying' },
                {
                    $set: {
                        status: 'rejected',
                        verificationReason: verdict.reason || 'Rejected by reviewer',
                        aiReviewerModel: proModel,
                        updatedAt: new Date()
                    }
                }
            );
        }
    } catch (err) {
        console.error('grader pro verify:', clashId, err.message);
        await Clash.findOneAndUpdate(
            { _id: clashId, status: 'verifying' },
            {
                $set: {
                    status: 'rejected',
                    verificationReason: truncate(err.message || 'Verification failed', 500),
                    aiReviewerModel: proModel,
                    updatedAt: new Date()
                }
            }
        );
    }
}

/** POST /api/grader/clashes — Flash generates immediately; Pro verifies in background. */
router.post('/clashes', authMiddleware, aiCreateLimiter, async (req, res) => {
    try {
        const { mode, topic, difficulty, languages } = req.body;
        if (!['reverse', 'fastest', 'shortest'].includes(mode)) {
            return res.status(400).json({ error: 'mode must be reverse, fastest, or shortest' });
        }

        const flashModel = flashModelId();
        const payload = await generateClash({
            mode,
            topic: topic && String(topic).slice(0, 200),
            difficulty: difficulty && String(difficulty).slice(0, 50),
            languages,
            modelId: flashModel
        });

        let slug = makeSlug();
        for (let i = 0; i < 5; i++) {
            const exists = await Clash.findOne({ slug });
            if (!exists) break;
            slug = makeSlug();
        }

        const roomDurationMs = resolveRoomDurationMs(req.body);

        const clash = await Clash.create({
            slug,
            mode,
            status: 'verifying',
            title: payload.title,
            statement: payload.statement,
            samples: payload.samples,
            tests: payload.tests,
            allowedLanguages: payload.allowedLanguages,
            timeLimitMs: Math.min(Number(req.body.timeLimitMs) || 8000, 15000),
            roomDurationMs,
            createdBy: req.user.id,
            aiModel: flashModel
        });

        setImmediate(() => {
            runProVerification(clash._id).catch((e) => console.error('verify bg', e));
        });

        return res.status(201).json({
            slug: clash.slug,
            mode: clash.mode,
            title: clash.title,
            status: 'verifying',
            message: 'Problem generated. A Pro model is reviewing quality; refresh until status is ready, then click Start.',
            joinPath: `/clash/${clash.slug}`
        });
    } catch (err) {
        console.error('grader create:', err.message);
        const status = err.message && err.message.includes('GEMINI_API_KEY') ? 503 : 400;
        return res.status(status).json({ error: err.message || 'Failed to create clash' });
    }
});

/** GET /api/grader/clashes — list joinable / visible clashes */
router.get('/clashes', async (req, res) => {
    try {
        const list = await Clash.find({
            $or: [
                { status: { $exists: false } },
                { status: { $in: ['ready', 'live', 'ended'] } }
            ]
        })
            .sort({ createdAt: -1 })
            .limit(40)
            .select('slug mode title createdAt allowedLanguages status')
            .lean();
        res.json(list);
    } catch (err) {
        res.status(500).json({ error: 'Failed to list clashes' });
    }
});

/** GET /api/grader/clashes/:slug — optional auth for isOwner / canStart */
router.get('/clashes/:slug', optionalAuth, async (req, res) => {
    try {
        let clash = await Clash.findOne({ slug: req.params.slug }).populate('createdBy', 'username').lean();
        if (!clash) return res.status(404).json({ error: 'Clash not found' });

        await maybeCloseExpired(clash);
        const st = effectiveStatus(clash);
        const uid = req.user && req.user.id;
        const ownerId = clash.createdBy && clash.createdBy._id ? clash.createdBy._id.toString() : String(clash.createdBy);
        const isOwner = !!(uid && ownerId === uid);

        const base = {
            slug: clash.slug,
            mode: clash.mode,
            status: st,
            serverTime: new Date().toISOString(),
            roomDurationMs: clash.roomDurationMs || ROOM_DURATION_PRESETS_MS[15],
            timeLimitMs: clash.timeLimitMs,
            allowedLanguages: clash.allowedLanguages,
            createdAt: clash.createdAt,
            author: clash.createdBy && clash.createdBy.username,
            isOwner,
            canStart: isOwner && st === 'ready',
            verificationReason: clash.verificationReason,
            startedAt: clash.startedAt,
            endsAt: clash.endsAt
        };

        if (st === 'verifying') {
            return res.json({
                ...base,
                title: clash.title,
                message: 'A Pro model is reviewing this problem. Problem statement and tests unlock after approval and Start.'
            });
        }
        if (st === 'rejected') {
            return res.json({
                ...base,
                title: clash.title,
                message: 'This clash did not pass automated review.'
            });
        }
        if (st === 'ready') {
            return res.json({
                ...base,
                title: clash.title,
                message: isOwner
                    ? 'Review passed. Click Start to open the problem and begin the match timer.'
                    : 'Waiting for the host to start the clash.'
            });
        }

        const publicTests = (clash.tests || []).filter((t) => !t.hidden).map((t) => ({
            input: t.input,
            output: t.output,
            hidden: false
        }));

        let secondsRemaining = null;
        if (st === 'live' && clash.endsAt) {
            const ms = new Date(clash.endsAt).getTime() - Date.now();
            secondsRemaining = Math.max(0, Math.floor(ms / 1000));
        }

        return res.json({
            ...base,
            title: clash.title,
            statement: clash.statement,
            samples: clash.samples,
            publicTests,
            publicTestCount: publicTests.length,
            hiddenTestCount: (clash.tests || []).filter((t) => t.hidden).length,
            secondsRemaining
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load clash' });
    }
});

/** POST /api/grader/clashes/:slug/start — host only; reveals timer and opens submissions */
router.post('/clashes/:slug/start', authMiddleware, async (req, res) => {
    try {
        const clash = await Clash.findOne({ slug: req.params.slug });
        if (!clash) return res.status(404).json({ error: 'Clash not found' });
        if (String(clash.createdBy) !== req.user.id) {
            return res.status(403).json({ error: 'Only the clash creator can start the timer' });
        }
        if (clash.status !== 'ready') {
            return res.status(400).json({ error: 'Clash is not waiting to start (must be ready)' });
        }
        const now = new Date();
        const duration = clash.roomDurationMs || ROOM_DURATION_PRESETS_MS[15];
        clash.status = 'live';
        clash.startedAt = now;
        clash.endsAt = new Date(now.getTime() + duration);
        await clash.save();
        return res.json({
            status: clash.status,
            startedAt: clash.startedAt,
            endsAt: clash.endsAt,
            roomDurationMs: duration
        });
    } catch (err) {
        console.error('grader start:', err);
        res.status(500).json({ error: err.message || 'Start failed' });
    }
});

/** POST /api/grader/clashes/:slug/submit */
router.post('/clashes/:slug/submit', authMiddleware, submitLimiter, async (req, res) => {
    try {
        let clash = await Clash.findOne({ slug: req.params.slug });
        if (!clash) return res.status(404).json({ error: 'Clash not found' });

        clash = await maybeCloseExpired(clash);
        const st = effectiveStatus(clash);
        if (st !== 'live') {
            return res.status(400).json({ error: 'Submissions are only open while the clash is live. Use Start from the host account first.' });
        }
        if (clash.endsAt && new Date() >= new Date(clash.endsAt)) {
            return res.status(400).json({ error: 'The clash timer has ended' });
        }

        const { language, code } = req.body;
        if (!language || !code) {
            return res.status(400).json({ error: 'language and code are required' });
        }
        if (!clash.allowedLanguages.includes(language)) {
            return res.status(400).json({ error: `Language not allowed for this clash: ${clash.allowedLanguages.join(', ')}` });
        }

        const tests = clash.tests || [];
        if (!tests.length) return res.status(500).json({ error: 'Clash has no tests' });

        const charCount = String(code).trim().length;
        const testResults = [];
        const failures = [];
        let totalTimeMs = 0;
        let accepted = true;

        for (let i = 0; i < tests.length; i++) {
            const t = tests[i];
            const stdin = t.input == null ? '' : String(t.input);
            const expected = normalizeProgramOutput(t.output);

            const r = await executeCodeWithStdin({
                code,
                language,
                stdin,
                timeLimitMs: clash.timeLimitMs || 8000
            });

            const wall = typeof r.execTimeMs === 'number' ? r.execTimeMs : 0;
            totalTimeMs += wall;

            if (!r.ok && r.stage === 'compile') {
                accepted = false;
                testResults.push({
                    index: i,
                    pass: false,
                    hidden: !!t.hidden,
                    timeMs: wall,
                    stdoutSnippet: '',
                    stderrSnippet: truncate(r.stderr || r.error || '', 500)
                });
                if (!t.hidden) {
                    failures.push({
                        index: i,
                        inputPreview: truncate(stdin, 800),
                        expected: truncate(expected, 2000),
                        actual: '',
                        stderr: truncate(r.stderr || r.error || '', 1500)
                    });
                }
                break;
            }

            if (!r.ok) {
                accepted = false;
                testResults.push({
                    index: i,
                    pass: false,
                    hidden: !!t.hidden,
                    timeMs: wall,
                    stdoutSnippet: '',
                    stderrSnippet: truncate(r.stderr || r.error || '', 500)
                });
                if (!t.hidden) {
                    failures.push({
                        index: i,
                        inputPreview: truncate(stdin, 800),
                        expected: truncate(expected, 2000),
                        actual: '',
                        stderr: truncate(r.stderr || r.error || '', 1500)
                    });
                }
                continue;
            }

            const outNorm = normalizeProgramOutput(r.stdout || '');
            const pass = !r.timedOut && Number(r.code) === 0 && outNorm === expected;
            if (!pass) accepted = false;

            testResults.push({
                index: i,
                pass,
                hidden: !!t.hidden,
                timeMs: wall,
                stdoutSnippet: truncate(r.stdout || '', 400),
                stderrSnippet: truncate(r.stderr || '', 400)
            });

            if (!pass && !t.hidden) {
                failures.push({
                    index: i,
                    inputPreview: truncate(stdin, 800),
                    expected: truncate(expected, 2000),
                    actual: truncate(r.stdout || '', 2000),
                    stderr: truncate(r.stderr || '', 800)
                });
            }
        }

        const submission = await ClashSubmission.create({
            clashId: clash._id,
            userId: req.user.id,
            language,
            code: String(code).slice(0, 200000),
            charCount,
            accepted,
            totalTimeMs,
            testResults,
            failures
        });

        res.json({
            accepted,
            totalTimeMs,
            charCount,
            mode: clash.mode,
            testResults: testResults.map((tr) => ({
                index: tr.index,
                pass: tr.pass,
                hidden: tr.hidden,
                timeMs: tr.timeMs
            })),
            failures
        });
    } catch (err) {
        console.error('grader submit:', err);
        res.status(500).json({ error: err.message || 'Submit failed' });
    }
});

/** GET /api/grader/clashes/:slug/leaderboard */
router.get('/clashes/:slug/leaderboard', async (req, res) => {
    try {
        const clash = await Clash.findOne({ slug: req.params.slug }).lean();
        if (!clash) return res.status(404).json({ error: 'Clash not found' });

        const subs = await ClashSubmission.find({ clashId: clash._id, accepted: true })
            .populate('userId', 'username')
            .sort({ createdAt: -1 })
            .lean();

        const bestByUser = new Map();
        for (const s of subs) {
            const uid = s.userId && s.userId._id ? s.userId._id.toString() : String(s.userId);
            const username = (s.userId && s.userId.username) || 'User';
            const cur = bestByUser.get(uid);
            if (!cur) {
                bestByUser.set(uid, { ...s, username });
                continue;
            }
            if (clash.mode === 'shortest') {
                if (s.charCount < cur.charCount) bestByUser.set(uid, { ...s, username });
            } else {
                if (s.totalTimeMs < cur.totalTimeMs) bestByUser.set(uid, { ...s, username });
            }
        }

        let rows = [...bestByUser.values()];
        if (clash.mode === 'shortest') {
            rows.sort((a, b) => a.charCount - b.charCount || new Date(a.createdAt) - new Date(b.createdAt));
        } else {
            rows.sort((a, b) => a.totalTimeMs - b.totalTimeMs || new Date(a.createdAt) - new Date(b.createdAt));
        }

        rows = rows.slice(0, 50).map((r, rank) => ({
            rank: rank + 1,
            username: r.username,
            totalTimeMs: r.totalTimeMs,
            charCount: r.charCount,
            language: r.language,
            submittedAt: r.createdAt
        }));

        res.json({ mode: clash.mode, leaderboard: rows });
    } catch (err) {
        res.status(500).json({ error: 'Leaderboard failed' });
    }
});

module.exports = router;
