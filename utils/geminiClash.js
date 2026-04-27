/**
 * Clash problem generation (Flash) + quality review (Pro) via Google Generative Language API.
 * Defaults follow Gemini 3 docs: https://ai.google.dev/gemini-api/docs/gemini-3
 * Env: GEMINI_API_KEY, GEMINI_MODEL_FLASH (default gemini-3-flash-preview), GEMINI_MODEL_PRO (default gemini-3.1-pro-preview),
 * optional GEMINI_MODEL (fallback if GEMINI_MODEL_FLASH unset), GEMINI_API_BASE.
 */

const API_BASE = (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');

const MAX_TESTS = 16;
const MAX_SAMPLES = 5;
const MAX_IO_CHARS = 6000;
const MAX_TITLE = 200;

function flashModelId() {
    return process.env.GEMINI_MODEL_FLASH || process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
}

function proModelId() {
    return process.env.GEMINI_MODEL_PRO || 'gemini-3.1-pro-preview';
}

function stripJsonFence(text) {
    let t = String(text || '').trim();
    if (t.startsWith('```')) {
        t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    }
    return t.trim();
}

async function callGeminiGenerateJson(modelId, bodyPayload) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
        throw new Error('GEMINI_API_KEY is not configured');
    }
    const url = `${API_BASE}/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPayload)
    });
    const rawText = await res.text();
    if (!res.ok) {
        let msg = rawText.slice(0, 300);
        try {
            const j = JSON.parse(rawText);
            if (j.error?.message) msg = j.error.message;
        } catch (_) { /* ignore */ }
        throw new Error(`Gemini API error (${res.status}): ${msg}`);
    }
    const outer = JSON.parse(rawText);
    const cand = outer.candidates?.[0];
    if (!cand) throw new Error('No candidates (blocked or empty response)');
    if (cand.finishReason && ['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT'].includes(cand.finishReason)) {
        throw new Error('Gemini blocked this response: ' + cand.finishReason);
    }
    const parts = cand.content?.parts || [];
    let txt = '';
    for (const p of parts) {
        if (p.text) txt += p.text;
    }
    if (!txt.trim()) throw new Error('Empty model output');
    const stripped = stripJsonFence(txt);
    return JSON.parse(stripped);
}

function validateAndNormalizeClash(obj, mode) {
    if (!obj || typeof obj !== 'object') throw new Error('Invalid AI response: not an object');
    const title = String(obj.title || 'Untitled').slice(0, MAX_TITLE).trim();
    let statement = String(obj.statement || '');
    if (mode === 'reverse') {
        statement = statement.slice(0, 4000);
    } else {
        statement = statement.slice(0, 12000);
    }

    const samples = Array.isArray(obj.samples) ? obj.samples.slice(0, MAX_SAMPLES) : [];
    const normSamples = samples.map((s) => ({
        input: String(s.input != null ? s.input : '').slice(0, MAX_IO_CHARS),
        output: String(s.output != null ? s.output : '').slice(0, MAX_IO_CHARS)
    }));

    const tests = Array.isArray(obj.tests) ? obj.tests.slice(0, MAX_TESTS) : [];
    if (tests.length < 2) throw new Error('AI must return at least 2 test cases');
    const normTests = tests.map((t, i) => ({
        input: String(t.input != null ? t.input : '').slice(0, MAX_IO_CHARS),
        output: String(t.output != null ? t.output : '').slice(0, MAX_IO_CHARS),
        hidden: !!t.hidden || i >= tests.length - 2
    }));
    const hiddenCount = normTests.filter((t) => t.hidden).length;
    if (hiddenCount < 1) {
        normTests[normTests.length - 1].hidden = true;
    }

    let allowed = Array.isArray(obj.allowedLanguages) ? obj.allowedLanguages.map(String) : ['python', 'javascript'];
    const allowedSet = new Set(['python', 'javascript', 'typescript', 'cpp', 'java', 'go', 'rust', 'php', 'ruby', 'csharp']);
    allowed = [...new Set(allowed.filter((l) => allowedSet.has(l)))];
    if (!allowed.length) allowed = ['python', 'javascript'];

    return { title, statement, samples: normSamples, tests: normTests, allowedLanguages: allowed };
}

async function generateClash({ mode, topic, difficulty, languages, modelId }) {
    const model = modelId || flashModelId();

    const langHint = Array.isArray(languages) && languages.length
        ? languages.join(', ')
        : 'python, javascript, typescript';

    const modeInstructions = {
        reverse: `Mode REVERSE: do NOT explain the algorithm in plain prose. Give a very short neutral title only.
The user must infer the transformation from samples only. statement may be empty or one sentence like "Match the samples."
Provide 3–5 public samples and 4–10 tests total; mark at least 2 tests hidden=true (different cases than samples).`,
        fastest: `Mode FASTEST: classic problem with clear statement. Include edge cases in hidden tests.`,
        shortest: `Mode SHORTEST: same as fastest but encourage golf-style solvable problem (still deterministic I/O).`
    };

    const prompt = `You are a programming contest problem generator. Output ONLY valid JSON (no markdown), one object with keys:
title (string), statement (string), samples (array of {input, output}), tests (array of {input, output, hidden boolean}), allowedLanguages (array of strings, subset of: ${langHint}).

Rules:
- All inputs/outputs are plain text; use \\n for newlines inside strings in JSON (escape properly).
- Deterministic: one correct output per input.
- Total tests between 4 and ${MAX_TESTS}.
- At least 2 tests must have hidden=true.
- Sample cases should not duplicate hidden tests exactly.

${modeInstructions[mode] || modeInstructions.fastest}

Topic hint: ${topic || 'general algorithms / strings / math'}.
Difficulty: ${difficulty || 'mixed'}.

Return JSON only.`;

    const parsed = await callGeminiGenerateJson(model, {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
            temperature: 0.35,
            maxOutputTokens: 8192,
            responseMimeType: 'application/json'
        }
    });

    return validateAndNormalizeClash(parsed, mode);
}

/**
 * Second-pass review (intended for a Pro-class model). Runs after Flash generation; does not block the HTTP create handler.
 */
async function verifyClashProblem({ mode, title, statement, samples, tests, modelId }) {
    const model = modelId || proModelId();
    const payload = {
        mode,
        title,
        statement,
        samples,
        tests: (tests || []).map((t) => ({
            input: t.input,
            output: t.output,
            hidden: !!t.hidden
        }))
    };

    const prompt = `You are an expert competitive programming reviewer (ICPC-style). You must verify a problem specification before it is shown to contestants.

You will receive JSON describing a problem (mode, title, statement, samples, tests with hidden flags). Check:
1) Statement (if any) is consistent with samples for non-reverse modes; for reverse mode, samples alone should define a plausible rule.
2) Every test has well-formed plain-text input/output; outputs are plausible deterministic results for the inputs.
3) At least one test has hidden=true and hidden tests are not trivial duplicates of all samples.
4) The problem is suitable for an automated stdin/stdout judge (no network, no randomness unless fully specified).

Input JSON:
${JSON.stringify(payload).slice(0, 120000)}

Reply with ONLY valid JSON, one object: either {"approved": true} or {"approved": false, "reason": "short explanation"}.`;

    const parsed = await callGeminiGenerateJson(model, {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
            temperature: 0.15,
            maxOutputTokens: 2048,
            responseMimeType: 'application/json'
        }
    });

    if (!parsed || typeof parsed !== 'object') {
        return { approved: false, reason: 'Reviewer returned invalid JSON shape' };
    }
    if (parsed.approved === true || parsed.approved === 'true') return { approved: true };
    const reason = String(parsed.reason || 'Reviewer rejected the problem').slice(0, 2000);
    return { approved: false, reason };
}

module.exports = {
    generateClash,
    verifyClashProblem,
    validateAndNormalizeClash,
    flashModelId,
    proModelId,
    MAX_TESTS,
    MAX_IO_CHARS
};
