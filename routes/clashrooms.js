const express = require('express');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const authMiddleware = require('../middleware/auth');
const optionalAuth = require('../middleware/optionalAuth');
const ClashRoom = require('../models/ClashRoom');
const ClashPremade = require('../models/ClashPremade');
const ClashRoomSubmission = require('../models/ClashRoomSubmission');
const {
    generateClashRoomProblem,
    verifyClashRoomProblem,
    flashModelId,
    proModelId
} = require('../utils/geminiClashRoom');
const { executeCodeWithStdin, normalizeProgramOutput, listRunnerLanguages } = require('../utils/sandboxRun');
const { pickRandomTemplate } = require('../utils/clashRoomBank');
const registeredUserOnly = require('../middleware/registeredUserOnly');

const router = express.Router();
const ALL_RUNNER_LANGS = listRunnerLanguages();

const ROOM_DURATION_PRESETS_MS = {
    5: 5 * 60 * 1000,
    10: 10 * 60 * 1000,
    15: 15 * 60 * 1000,
    30: 30 * 60 * 1000,
    60: 60 * 60 * 1000
};

const createLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 6,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many room creations; try again in a minute' }
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

function resolveAllowedModes(body) {
    let m = body.allowedModes;
    if (!Array.isArray(m) || !m.length) {
        return ['fastest', 'reverse', 'shortest'];
    }
    m = m.map((x) => String(x).toLowerCase()).filter((x) => ['reverse', 'fastest', 'shortest'].includes(x));
    return m.length ? [...new Set(m)] : ['fastest'];
}

function pickResolvedMode(modes) {
    return modes[Math.floor(Math.random() * modes.length)];
}

function resolveLanguagesList(body) {
    if (body.languagesAll === true || body.languagesAll === 'true') {
        return [...ALL_RUNNER_LANGS];
    }
    if (Array.isArray(body.allowedLanguages) && body.allowedLanguages.length) {
        return [...new Set(body.allowedLanguages.filter((l) => ALL_RUNNER_LANGS.includes(l)))];
    }
    return ['python', 'javascript'];
}

function languageAllowedDoc(room, lang) {
    if (room.languagesAll) return ALL_RUNNER_LANGS.includes(lang);
    return (room.allowedLanguages || []).includes(lang);
}

function truncate(s, n) {
    const t = String(s || '');
    if (t.length <= n) return t;
    return t.slice(0, n) + '\n… [truncated]';
}

function resolveRoomDurationMs(body) {
    const m = Number(body.roomDurationMinutes);
    if (ROOM_DURATION_PRESETS_MS[m]) return ROOM_DURATION_PRESETS_MS[m];
    return ROOM_DURATION_PRESETS_MS[15];
}

/** Advance countdown→live and live→ended when wall clock has passed. */
async function pulseRoomBySlug(slug) {
    const room = await ClashRoom.findOne({ slug });
    if (!room) return null;
    const now = Date.now();

    if (room.phase === 'lobby' && room.status === 'ready') {
        room.phase = 'countdown';
        room.countdownEndsAt = new Date(now + (room.countdownDurationMs || 300000));
        await room.save();
    }

    if (room.phase === 'countdown' && room.status === 'ready' && room.countdownEndsAt
        && new Date(room.countdownEndsAt).getTime() <= now) {
        room.phase = 'live';
        room.startedAt = new Date();
        room.endsAt = new Date(now + (room.roomDurationMs || ROOM_DURATION_PRESETS_MS[15]));
        room.countdownEndsAt = undefined;
        await room.save();
    }

    if (room.phase === 'live' && room.status === 'ready' && room.endsAt
        && new Date(room.endsAt).getTime() <= now) {
        room.phase = 'ended';
        await room.save();
    }

    return room;
}

function isJoinPhase(room) {
    if (room.status === 'rejected') return false;
    if (room.phase === 'live' || room.phase === 'ended') return false;
    if (room.phase === 'preparing' && room.status === 'verifying') return true;
    if (room.phase === 'lobby' || room.phase === 'countdown') return room.status === 'ready';
    return false;
}

function problemHidden(room) {
    return ['preparing', 'lobby', 'countdown'].includes(room.phase);
}

async function runProVerification(roomId) {
    const room = await ClashRoom.findById(roomId);
    if (!room || room.status !== 'verifying' || room.phase !== 'preparing') return;

    const proModel = proModelId();
    try {
        const verdict = await verifyClashRoomProblem({
            mode: room.resolvedMode,
            title: room.title,
            statement: room.statement,
            samples: room.samples,
            tests: room.tests,
            modelId: proModel
        });

        if (verdict.approved) {
            const countdownDurationMs = room.countdownDurationMs || 300000;
            await ClashRoom.findOneAndUpdate(
                { _id: roomId, status: 'verifying', phase: 'preparing' },
                {
                    $set: {
                        status: 'ready',
                        phase: 'countdown',
                        countdownEndsAt: new Date(Date.now() + countdownDurationMs),
                        aiReviewerModel: proModel,
                        updatedAt: new Date()
                    }
                }
            );
        } else {
            await ClashRoom.findOneAndUpdate(
                { _id: roomId, status: 'verifying', phase: 'preparing' },
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
        console.error('clashrooms pro verify:', roomId, err.message);
        await ClashRoom.findOneAndUpdate(
            { _id: roomId, status: 'verifying', phase: 'preparing' },
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

/** Atomically take next admin premade for this mode (FIFO), or null if queue empty. */
async function claimPremade(resolvedMode) {
    for (let i = 0; i < 4; i++) {
        const cand = await ClashPremade.findOne({ status: 'available', resolvedMode })
            .sort({ createdAt: 1 })
            .select('_id');
        if (!cand) return null;
        const updated = await ClashPremade.findOneAndUpdate(
            { _id: cand._id, status: 'available' },
            { $set: { status: 'consumed', consumedAt: new Date() } },
            { new: true }
        ).lean();
        if (updated) return updated;
    }
    return null;
}

function redactedListRow(room, hostUsername) {
    const row = {
        slug: room.slug,
        phase: room.phase,
        status: room.status,
        createdAt: room.createdAt,
        participantCount: (room.participantIds || []).length,
        maxPlayers: room.maxPlayers || 50,
        hostUsername: hostUsername || null,
        sourceKind: room.sourceKind || 'bank',
        languagesAll: !!room.languagesAll,
        allowedLanguages: room.languagesAll ? [...ALL_RUNNER_LANGS] : (room.allowedLanguages || []),
        allowedModesPick: room.allowedModesPick || [],
        countdownEndsAt: room.countdownEndsAt || null
    };
    if (room.phase === 'live' || room.phase === 'ended') {
        row.endsAt = room.endsAt || null;
    } else {
        row.endsAt = null;
    }
    return row;
}

/** POST /api/clashrooms */
router.post('/', authMiddleware, registeredUserOnly, createLimiter, async (req, res) => {
    try {
        const modesPick = resolveAllowedModes(req.body);
        const resolvedMode = pickResolvedMode(modesPick);
        const langs = resolveLanguagesList(req.body);
        const languagesAll = !!(req.body.languagesAll === true || req.body.languagesAll === 'true');
        const sourceRaw = String(req.body.source || 'auto').toLowerCase();
        let useBank = sourceRaw === 'bank' || (sourceRaw === 'auto' && Math.random() < 0.5);
        if (sourceRaw === 'ai') useBank = false;
        if (!process.env.GEMINI_API_KEY) useBank = true;
        if (sourceRaw === 'ai' && !process.env.GEMINI_API_KEY) useBank = true;

        let effectiveSourceKind = 'ai';
        if (useBank) {
            if (sourceRaw === 'auto') effectiveSourceKind = 'auto';
            else if (sourceRaw === 'bank') effectiveSourceKind = 'bank';
            else effectiveSourceKind = 'bank';
        }

        let slug = makeSlug();
        for (let i = 0; i < 5; i++) {
            const exists = await ClashRoom.findOne({ slug });
            if (!exists) break;
            slug = makeSlug();
        }

        const roomDurationMs = resolveRoomDurationMs(req.body);
        const maxPlayers = Math.min(50, Math.max(1, parseInt(req.body.maxPlayers, 10) || 50));
        const cdMin = Number(req.body.lobbyCountdownMinutes);
        const countdownDurationMs = (cdMin >= 1 && cdMin <= 15 ? cdMin : 5) * 60 * 1000;

        const tryPremadeFirst = req.body.tryPremadeFirst !== false && req.body.tryPremadeFirst !== 'false'
            && sourceRaw !== 'ai';

        if (tryPremadeFirst) {
            const premadeDoc = await claimPremade(resolvedMode);
            if (premadeDoc) {
                const tests = (premadeDoc.tests || []).map((t) => ({
                    input: String(t.input != null ? t.input : ''),
                    output: String(t.output != null ? t.output : ''),
                    hidden: !!t.hidden
                }));
                if (!tests.length) {
                    await ClashPremade.updateOne(
                        { _id: premadeDoc._id },
                        { $set: { status: 'available', consumedAt: null } }
                    ).catch(() => {});
                    return res.status(400).json({ error: 'Queued premade had no tests — re-added to queue. Fix it in admin.' });
                }
                const payload = {
                    title: premadeDoc.title,
                    statement: premadeDoc.statement || '',
                    samples: premadeDoc.samples || [],
                    tests,
                    allowedLanguages: (premadeDoc.allowedLanguages && premadeDoc.allowedLanguages.length)
                        ? premadeDoc.allowedLanguages
                        : ALL_RUNNER_LANGS
                };
                let room;
                try {
                    room = await ClashRoom.create({
                        slug,
                        resolvedMode,
                        phase: 'lobby',
                        status: 'ready',
                        allowedModesPick: modesPick,
                        languagesAll,
                        participantIds: [req.user.id],
                        maxPlayers,
                        countdownDurationMs,
                        sourceKind: 'premade',
                        title: payload.title,
                        statement: payload.statement,
                        samples: payload.samples,
                        tests: payload.tests,
                        allowedLanguages: languagesAll
                            ? ALL_RUNNER_LANGS
                            : langs.filter((l) => (payload.allowedLanguages || ALL_RUNNER_LANGS).includes(l)),
                        timeLimitMs: Math.min(Number(req.body.timeLimitMs) || 8000, 15000),
                        roomDurationMs,
                        createdBy: req.user.id
                    });
                } catch (saveErr) {
                    await ClashPremade.updateOne(
                        { _id: premadeDoc._id },
                        { $set: { status: 'available', consumedAt: null } }
                    ).catch(() => {});
                    throw saveErr;
                }
                return res.status(201).json({
                    slug: room.slug,
                    phase: room.phase,
                    status: room.status,
                    sourceKind: room.sourceKind,
                    message: 'Private room created from admin premade queue. Invite players — nothing is revealed until the countdown finishes.',
                    joinPath: `/clash/${room.slug}`
                });
            }
        }

        if (useBank) {
            const payload = pickRandomTemplate(resolvedMode);
            const room = await ClashRoom.create({
                slug,
                resolvedMode,
                phase: 'lobby',
                status: 'ready',
                allowedModesPick: modesPick,
                languagesAll,
                participantIds: [req.user.id],
                maxPlayers,
                countdownDurationMs,
                sourceKind: effectiveSourceKind,
                title: payload.title,
                statement: payload.statement,
                samples: payload.samples,
                tests: payload.tests,
                allowedLanguages: languagesAll
                    ? ALL_RUNNER_LANGS
                    : langs.filter((l) => (payload.allowedLanguages || ALL_RUNNER_LANGS).includes(l)),
                timeLimitMs: Math.min(Number(req.body.timeLimitMs) || 8000, 15000),
                roomDurationMs,
                createdBy: req.user.id
            });
            return res.status(201).json({
                slug: room.slug,
                phase: room.phase,
                status: room.status,
                sourceKind: room.sourceKind,
                message: 'Private room created from puzzle bank. Invite players — nothing is revealed until the countdown finishes.',
                joinPath: `/clash/${room.slug}`
            });
        }

        const flashModel = flashModelId();
        const payload = await generateClashRoomProblem({
            mode: resolvedMode,
            topic: req.body.topic && String(req.body.topic).slice(0, 200),
            difficulty: req.body.difficulty && String(req.body.difficulty).slice(0, 50),
            languages: languagesAll ? ALL_RUNNER_LANGS : langs,
            modelId: flashModel
        });

        const room = await ClashRoom.create({
            slug,
            resolvedMode,
            phase: 'preparing',
            status: 'verifying',
            allowedModesPick: modesPick,
            languagesAll,
            participantIds: [req.user.id],
            maxPlayers,
            countdownDurationMs,
            sourceKind: effectiveSourceKind,
            title: payload.title,
            statement: payload.statement,
            samples: payload.samples,
            tests: payload.tests,
            allowedLanguages: languagesAll ? ALL_RUNNER_LANGS : payload.allowedLanguages,
            timeLimitMs: Math.min(Number(req.body.timeLimitMs) || 8000, 15000),
            roomDurationMs,
            createdBy: req.user.id,
            aiModel: flashModel
        });

        setImmediate(() => {
            runProVerification(room._id).catch((e) => console.error('clashrooms verify bg', e));
        });

        return res.status(201).json({
            slug: room.slug,
            phase: room.phase,
            status: room.status,
            sourceKind: effectiveSourceKind,
            message: 'Room created. AI is preparing a puzzle — invite players; nothing is revealed until the match starts.',
            joinPath: `/clash/${room.slug}`
        });
    } catch (err) {
        console.error('clashrooms create:', err.message);
        const status = err.message && err.message.includes('GEMINI_API_KEY') ? 503 : 400;
        return res.status(status).json({ error: err.message || 'Failed to create room' });
    }
});

/** GET /api/clashrooms — hub list (redacted, never puzzle fields) */
router.get('/', async (req, res) => {
    try {
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 40));
        const skip = Math.max(0, parseInt(req.query.skip, 10) || 0);

        const rooms = await ClashRoom.find({})
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('createdBy', 'username')
            .lean();

        const rows = rooms.map((r) => {
            const hostUsername = r.createdBy && r.createdBy.username ? r.createdBy.username : null;
            return redactedListRow(r, hostUsername);
        });
        res.json(rows);
    } catch (err) {
        console.error('clashrooms list:', err);
        res.status(500).json({ error: 'Failed to list rooms' });
    }
});

/** GET /api/clashrooms/options/sandbox-languages — for create-clash modal (before /:slug) */
router.get('/options/sandbox-languages', (req, res) => {
    res.json({ languages: ALL_RUNNER_LANGS });
});

function buildRoomDetailPayload(room, reqUserId) {
    const ownerId = room.createdBy && room.createdBy._id ? room.createdBy._id.toString() : String(room.createdBy);
    const isOwner = !!(reqUserId && ownerId === reqUserId);
    const participants = (room.participantIds || []).map((p) => ({
        username: (p && p.username) || 'User',
        id: p && p._id ? String(p._id) : ''
    }));

    const hidden = problemHidden(room);
    const base = {
        slug: room.slug,
        phase: room.phase,
        status: room.status,
        resolvedMode: hidden ? null : room.resolvedMode,
        mode: hidden ? null : room.resolvedMode,
        serverTime: new Date().toISOString(),
        roomDurationMs: room.roomDurationMs || ROOM_DURATION_PRESETS_MS[15],
        countdownDurationMs: room.countdownDurationMs || 300000,
        timeLimitMs: room.timeLimitMs,
        allowedLanguages: room.languagesAll ? ALL_RUNNER_LANGS : room.allowedLanguages,
        languagesAll: !!room.languagesAll,
        allowedModesPick: room.allowedModesPick || null,
        maxPlayers: room.maxPlayers || 50,
        participantCount: participants.length,
        participants,
        countdownEndsAt: room.countdownEndsAt || null,
        countdownSecondsRemaining: room.countdownEndsAt
            ? Math.max(0, Math.floor((new Date(room.countdownEndsAt).getTime() - Date.now()) / 1000))
            : null,
        createdAt: room.createdAt,
        author: room.createdBy && room.createdBy.username,
        isOwner,
        canStart: isOwner && room.phase === 'lobby' && room.status === 'ready',
        requiresRegisteredPlayer: true,
        invitePath: `/clash/${room.slug}`,
        verificationReason: room.verificationReason,
        startedAt: room.startedAt,
        endsAt: room.endsAt,
        sourceKind: room.sourceKind || null,
        problemHidden: hidden
    };

    if (room.phase === 'preparing' && room.status === 'verifying') {
        return {
            ...base,
            message: 'Room is locked while the puzzle is being prepared. Nothing is revealed yet.'
        };
    }
    if (room.status === 'rejected') {
        return {
            ...base,
            resolvedMode: null,
            mode: null,
            message: room.verificationReason || 'This room did not pass automated review.'
        };
    }
    if (hidden && room.phase === 'lobby') {
        return {
            ...base,
            message: isOwner
                ? 'Players can join with the link. When you are ready, start the countdown — the puzzle stays hidden until it hits zero.'
                : 'Waiting for the host to start the countdown. The puzzle is hidden until the match begins.'
        };
    }
    if (hidden && room.phase === 'countdown') {
        return {
            ...base,
            message: 'Match starting soon — puzzle still hidden until countdown ends.'
        };
    }

    const publicTests = (room.tests || []).filter((t) => !t.hidden).map((t) => ({
        input: t.input,
        output: t.output,
        hidden: false
    }));

    let secondsRemaining = null;
    if (room.phase === 'live' && room.endsAt) {
        const ms = new Date(room.endsAt).getTime() - Date.now();
        secondsRemaining = Math.max(0, Math.floor(ms / 1000));
    }
    if (room.phase === 'ended' && room.endsAt) {
        secondsRemaining = 0;
    }

    return {
        ...base,
        resolvedMode: room.resolvedMode,
        title: room.title,
        statement: room.statement,
        samples: room.samples,
        publicTests,
        publicTestCount: publicTests.length,
        hiddenTestCount: (room.tests || []).filter((t) => t.hidden).length,
        secondsRemaining
    };
}

/** GET /api/clashrooms/:slug */
router.get('/:slug', optionalAuth, async (req, res) => {
    try {
        await pulseRoomBySlug(req.params.slug);
        let room = await ClashRoom.findOne({ slug: req.params.slug })
            .populate('createdBy', 'username')
            .populate('participantIds', 'username')
            .lean();
        if (!room) return res.status(404).json({ error: 'Room not found' });

        const uid = req.user && req.user.id;
        const payload = buildRoomDetailPayload(room, uid);
        res.json(payload);
    } catch (err) {
        console.error('clashrooms get:', err);
        res.status(500).json({ error: 'Failed to load room' });
    }
});

/** POST /api/clashrooms/:slug/join */
router.post('/:slug/join', authMiddleware, registeredUserOnly, async (req, res) => {
    try {
        const room = await ClashRoom.findOne({ slug: req.params.slug });
        if (!room) return res.status(404).json({ error: 'Room not found' });
        if (!isJoinPhase(room)) {
            return res.status(400).json({ error: 'Lobby is closed for this room' });
        }
        const uid = req.user.id;
        const ids = (room.participantIds || []).map((id) => id.toString());
        if (!ids.includes(uid)) {
            if (ids.length >= (room.maxPlayers || 50)) {
                return res.status(400).json({ error: 'Room is full' });
            }
            room.participantIds.push(uid);
            await room.save();
        }
        return res.json({ ok: true, participantCount: room.participantIds.length });
    } catch (err) {
        console.error('clashrooms join:', err);
        res.status(500).json({ error: err.message || 'Join failed' });
    }
});

/** POST /api/clashrooms/:slug/leave — remove current user from participants (fixes admin player count). */
router.post('/:slug/leave', authMiddleware, async (req, res) => {
    try {
        const room = await ClashRoom.findOne({ slug: req.params.slug });
        if (!room) return res.status(404).json({ error: 'Room not found' });
        const uid = req.user.id;
        const before = (room.participantIds || []).length;
        room.participantIds = (room.participantIds || []).filter((id) => String(id) !== uid);
        if (room.participantIds.length === before) {
            return res.json({ ok: true, participantCount: before, unchanged: true });
        }
        await room.save();
        return res.json({ ok: true, participantCount: room.participantIds.length });
    } catch (err) {
        console.error('clashrooms leave:', err);
        res.status(500).json({ error: err.message || 'Leave failed' });
    }
});

/** POST /api/clashrooms/:slug/start */
router.post('/:slug/start', authMiddleware, async (req, res) => {
    try {
        const room = await ClashRoom.findOne({ slug: req.params.slug });
        if (!room) return res.status(404).json({ error: 'Room not found' });
        if (String(room.createdBy) !== req.user.id) {
            return res.status(403).json({ error: 'Only the host can start' });
        }
        if (room.phase !== 'lobby' || room.status !== 'ready') {
            return res.status(400).json({ error: 'Cannot start from this state' });
        }

        const ms = room.countdownDurationMs || 300000;
        room.phase = 'countdown';
        room.countdownEndsAt = new Date(Date.now() + ms);
        await room.save();
        return res.json({
            phase: room.phase,
            countdownEndsAt: room.countdownEndsAt,
            message: 'Countdown started. Puzzle unlocks when it reaches zero.'
        });
    } catch (err) {
        console.error('clashrooms start:', err);
        res.status(500).json({ error: err.message || 'Start failed' });
    }
});

/** POST /api/clashrooms/:slug/start-now — host skips countdown and unlocks the puzzle immediately. */
router.post('/:slug/start-now', authMiddleware, async (req, res) => {
    try {
        const room = await ClashRoom.findOne({ slug: req.params.slug });
        if (!room) return res.status(404).json({ error: 'Room not found' });
        if (String(room.createdBy) !== req.user.id) {
            return res.status(403).json({ error: 'Only the host can start now' });
        }
        if (!['lobby', 'countdown'].includes(room.phase) || room.status !== 'ready') {
            return res.status(400).json({ error: 'Cannot start now from this state' });
        }

        const now = Date.now();
        room.phase = 'live';
        room.startedAt = new Date(now);
        room.endsAt = new Date(now + (room.roomDurationMs || ROOM_DURATION_PRESETS_MS[15]));
        room.countdownEndsAt = undefined;
        await room.save();
        return res.json({
            phase: room.phase,
            startedAt: room.startedAt,
            endsAt: room.endsAt,
            message: 'Clash started now. Puzzle unlocked.'
        });
    } catch (err) {
        console.error('clashrooms start-now:', err);
        res.status(500).json({ error: err.message || 'Start now failed' });
    }
});

/** POST /api/clashrooms/:slug/submit */
router.post('/:slug/submit', authMiddleware, registeredUserOnly, submitLimiter, async (req, res) => {
    try {
        await pulseRoomBySlug(req.params.slug);
        let room = await ClashRoom.findOne({ slug: req.params.slug });
        if (!room) return res.status(404).json({ error: 'Room not found' });

        if (room.phase !== 'live' || room.status !== 'ready') {
            return res.status(400).json({ error: 'Submissions are only open during the live phase.' });
        }
        if (room.endsAt && new Date() >= new Date(room.endsAt)) {
            return res.status(400).json({ error: 'The match timer has ended' });
        }

        const ids = (room.participantIds || []).map((id) => String(id));
        if (!ids.includes(req.user.id)) {
            return res.status(403).json({ error: 'Join this room before submitting (registered account).' });
        }

        const { language, code } = req.body;
        if (!language || code == null) {
            return res.status(400).json({ error: 'language and code are required' });
        }
        if (!languageAllowedDoc(room, language)) {
            return res.status(400).json({ error: 'Language not allowed for this room' });
        }

        const tests = room.tests || [];
        if (!tests.length) return res.status(500).json({ error: 'Room has no tests' });

        const codeStr = String(code);
        const sourceByteLength = Buffer.byteLength(codeStr.trim(), 'utf8');
        const testResults = [];
        const failures = [];
        let totalTimeMs = 0;
        let accepted = true;

        for (let i = 0; i < tests.length; i++) {
            const t = tests[i];
            const stdin = t.input == null ? '' : String(t.input);
            const expected = normalizeProgramOutput(t.output);

            const r = await executeCodeWithStdin({
                code: codeStr,
                language,
                stdin,
                timeLimitMs: room.timeLimitMs || 8000
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
                    stderrSnippet: truncate(r.stderr || '', 500)
                });
                if (!t.hidden) {
                    failures.push({
                        index: i,
                        inputPreview: truncate(stdin, 800),
                        expected: truncate(expected, 2000),
                        actual: '',
                        stderr: truncate(r.stderr || '', 1500)
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

        const mode = room.resolvedMode;
        const now = new Date();
        const existing = await ClashRoomSubmission.findOne({ roomId: room._id, userId: req.user.id });

        if (accepted) {
            let shouldUpdateBest = false;
            if (!existing || !existing.accepted) {
                shouldUpdateBest = true;
            } else if (mode === 'shortest') {
                if (sourceByteLength < existing.sourceByteLength) shouldUpdateBest = true;
            } else {
                if (totalTimeMs < existing.totalTimeMs) shouldUpdateBest = true;
            }

            if (shouldUpdateBest) {
                await ClashRoomSubmission.findOneAndUpdate(
                    { roomId: room._id, userId: req.user.id },
                    {
                        $set: {
                            accepted: true,
                            totalTimeMs,
                            sourceByteLength,
                            language,
                            code: codeStr.slice(0, 200000),
                            bestAchievedAt: now,
                            lastAttemptAt: now,
                            lastFailures: null
                        },
                        $setOnInsert: { roomId: room._id, userId: req.user.id }
                    },
                    { upsert: true, new: true }
                );
            } else {
                await ClashRoomSubmission.findOneAndUpdate(
                    { roomId: room._id, userId: req.user.id },
                    {
                        $set: { lastAttemptAt: now, lastFailures: null },
                        $setOnInsert: { roomId: room._id, userId: req.user.id }
                    },
                    { upsert: true }
                );
            }
        } else {
            await ClashRoomSubmission.findOneAndUpdate(
                { roomId: room._id, userId: req.user.id },
                {
                    $set: {
                        lastAttemptAt: now,
                        lastFailures: { failures, testResults: testResults.map((tr) => ({
                            index: tr.index,
                            pass: tr.pass,
                            hidden: tr.hidden,
                            timeMs: tr.timeMs
                        })) }
                    },
                    $setOnInsert: { roomId: room._id, userId: req.user.id }
                },
                { upsert: true }
            );
        }

        res.json({
            accepted,
            totalTimeMs,
            sourceByteLength,
            charCount: sourceByteLength,
            mode,
            testResults: testResults.map((tr) => ({
                index: tr.index,
                pass: tr.pass,
                hidden: tr.hidden,
                timeMs: tr.timeMs
            })),
            failures
        });
    } catch (err) {
        console.error('clashrooms submit:', err);
        res.status(500).json({ error: err.message || 'Submit failed' });
    }
});

/** GET /api/clashrooms/:slug/leaderboard */
router.get('/:slug/leaderboard', async (req, res) => {
    try {
        const room = await ClashRoom.findOne({ slug: req.params.slug }).lean();
        if (!room) return res.status(404).json({ error: 'Room not found' });

        const subs = await ClashRoomSubmission.find({ roomId: room._id, accepted: true })
            .populate('userId', 'username')
            .lean();

        const mode = room.resolvedMode;
        let rows = subs.map((s) => ({
            username: (s.userId && s.userId.username) || 'User',
            totalTimeMs: s.totalTimeMs,
            charCount: s.sourceByteLength,
            sourceByteLength: s.sourceByteLength,
            language: s.language,
            submittedAt: s.bestAchievedAt || s.lastAttemptAt
        }));

        if (mode === 'shortest') {
            rows.sort((a, b) => a.sourceByteLength - b.sourceByteLength
                || new Date(a.submittedAt) - new Date(b.submittedAt));
        } else {
            rows.sort((a, b) => a.totalTimeMs - b.totalTimeMs
                || new Date(a.submittedAt) - new Date(b.submittedAt));
        }

        rows = rows.slice(0, 50).map((r, rank) => ({
            rank: rank + 1,
            username: r.username,
            totalTimeMs: r.totalTimeMs,
            charCount: r.sourceByteLength,
            language: r.language,
            submittedAt: r.submittedAt
        }));

        res.json({ mode, leaderboard: rows });
    } catch (err) {
        res.status(500).json({ error: 'Leaderboard failed' });
    }
});

module.exports = router;
