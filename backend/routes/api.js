const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const Annotator = require("../models/Annotator");
const Annotation = require("../models/Annotation");

const clipPairsPath = path.join(__dirname, "../data/clip_pairs.json");
const tokenPath = path.join(__dirname, "../data/tokens.json");
const goldPairsPath = path.join(__dirname, "../data/gold_pairs.json");

const GOLD_RATE = 0.07; // 7% of trials are gold
const REPEAT_GAP = 10; // schedule a repeat 10 trials after first seen
const REPEAT_RATE = 0.05; // enqueue repeats for 5% of seen items
const MAX_REPEAT_QUEUE = 5; // cap queue size
const ATTENTION_RATE = 1.0;

function getAnnotatorIdFromToken(token) {
    const tokens = loadTokens();
    const found = tokens.find((t) => t.token === token);
    return found ? found.annotatorId : null;
}

function loadTokens() {
    try {
        return JSON.parse(fs.readFileSync(tokenPath));
    } catch (e) {
        return [];
    }
}

function saveTokens(tokens) {
    fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
}

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_TOKEN = encodeURIComponent(process.env.ADMIN_TOKEN);

function requireAdmin(req, res, next) {
    const token = req.query.token || req.headers["x-admin-token"];
    if (token !== ADMIN_TOKEN) {
        return res.status(403).json({ error: "Forbidden" });
    }
    next();
}

router.post("/admin/login", (req, res) => {
    const { password } = req.body;

    if (password !== ADMIN_PASSWORD) {
        console.log(password);
        return res.status(401).json({ error: "Invalid password" });
    }
    res.json({ token: ADMIN_TOKEN });
});

router.get("/admin/progress", requireAdmin, async (req, res) => {
    const clipPairs = JSON.parse(fs.readFileSync(clipPairsPath));
    const annotators = await Annotator.find({});
    const result = annotators.map((a) => ({
        annotatorId: a.annotatorId,
        completed: a.completedPairs.length,
        total: clipPairs.length,
    }));
    res.json(result);
});

router.get("/admin/tokens", requireAdmin, (req, res) => {
    res.json(loadTokens());
});

router.get("/admin/export", requireAdmin, async (req, res) => {
    const annotations = await Annotation.find({});
    const output = annotations.map((a) => {
        const att = a.attention || {};
        const r = att.rect || {};
        const attentionUrl =
            att.side === "left"
                ? a.left?.url || null
                : att.side === "right"
                ? a.right?.url || null
                : null;
        return {
            annotator_id: a.annotatorId,
            pair_id: a.pairId,
            response: a.response,
            left_url: a.left?.url || null,
            right_url: a.right?.url || null,
            is_gold: a.isGold || false,
            gold_expected: a.goldExpected || null,
            gold_correct: typeof a.goldCorrect === "boolean" ? a.goldCorrect : null,
            is_repeat: a.isRepeat || false,
            repeat_of: a.repeatOf || null,
            presented_time: a.presentedTime || null,
            response_time_ms: typeof a.responseTimeMs === "number" ? a.responseTimeMs : null,

            attention_type: att.type || null,
            attention_side: att.side || null, // "left" | "right"
            attention_x: Number.isFinite(att.x) ? att.x : null, // [0,1] if coordSpace === 'normalised'
            attention_y: Number.isFinite(att.y) ? att.y : null,
            attention_coord_space: att.coordSpace || (att.rect ? "normalised" : null),
            attention_decision_ms: Number.isFinite(att.decisionAtMs) ? att.decisionAtMs : null,
            attention_url: attentionUrl, // convenience: URL of the chosen-side video at decision time

            timestamp: a.timestamp,
        };
    });
    res.json(output);
});

router.post("/admin/flush", requireAdmin, async (req, res) => {
    await Annotation.deleteMany({});
    await Annotator.deleteMany({});
    res.sendStatus(200);
});

router.post("/admin/add-annotator", requireAdmin, (req, res) => {
    const { annotatorId } = req.body || {};
    if (!annotatorId) return res.status(400).json({ error: "annotatorId required" });

    const tokens = loadTokens();
    if (tokens.some((t) => t.annotatorId === annotatorId)) {
        return res.status(409).json({ error: "Annotator ID already exists" });
    }

    const newToken = require("crypto").randomUUID().slice(0, 8);
    tokens.push({ annotatorId, token: newToken });
    saveTokens(tokens);

    return res.json({ annotatorId, token: newToken });
});

router.post("/admin/remove-annotator", requireAdmin, (req, res) => {
    const { annotatorId, token } = req.body || {};
    if (!annotatorId && !token) {
        return res.status(400).json({ error: "annotatorId or token required" });
    }

    const before = loadTokens();
    const after = before.filter(
        (t) =>
            (annotatorId ? t.annotatorId !== annotatorId : true) &&
            (token ? t.token !== token : true)
    );
    saveTokens(after);

    return res.sendStatus(200);
});

router.get("/clip-pairs", async (req, res) => {
    const token = req.query.token;
    const annotatorId = getAnnotatorIdFromToken(token);
    if (!annotatorId) return res.status(403).json({ error: "Invalid token" });

    const clipPairs = JSON.parse(fs.readFileSync(clipPairsPath));
    const goldPairs = JSON.parse(fs.readFileSync(goldPairsPath));
    let annotator = await Annotator.findOne({ annotatorId });
    if (!annotator)
        annotator = await Annotator.create({
            annotatorId,
            completedPairs: [],
            completedCount: 0,
            seenGold: [],
            repeatQueue: [],
        });

    // 1) Serve due repeat if any
    const dueIdx = annotator.repeatQueue.findIndex(
        (item) => annotator.completedCount >= item.targetAtCount
    );
    if (dueIdx >= 0) {
        const { pairId } = annotator.repeatQueue.splice(dueIdx, 1)[0];
        await annotator.save();
        const base = clipPairs.find((p) => p.pair_id === pairId);
        if (base) {
            const progress = {
                annotatorId: annotator.annotatorId,
                completed: annotator.completedCount,
                total: clipPairs.length,
            };
            return res.json({ ...base, progress, _meta: { isRepeat: true, repeatOf: pairId } });
        }
    }

    // 2) Maybe serve a gold (that this annotator hasn't seen)
    const unseenGolds = goldPairs.filter((g) => !annotator.seenGold.includes(g.pair_id));
    if (unseenGolds.length && Math.random() < GOLD_RATE) {
        const g = unseenGolds[Math.floor(Math.random() * unseenGolds.length)];
        const progress = {
            annotatorId: annotator.annotatorId,
            completed: annotator.completedCount,
            total: clipPairs.length,
        };
        // mark as seen (persist)
        annotator.seenGold.push(g.pair_id);
        await annotator.save();
        return res.json({ ...g, progress, _meta: { isGold: true, expected: g.expected } });
    }

    // 3) Serve next new pair
    const nextPair = clipPairs.find((p) => !annotator.completedPairs.includes(p.pair_id));
    const progress = {
        annotatorId: annotator.annotatorId,
        completed: annotator.completedCount,
        total: clipPairs.length,
    };
    // res.json(nextPair ? { ...nextPair, progress } : null);
    if (!nextPair) return res.json(null);
    const requireRegion = Math.random() < ATTENTION_RATE;
    res.json({ ...nextPair, progress, _meta: { requireRegion } });
});

router.post("/annotate", async (req, res) => {
    const token = req.body.token;
    const annotatorId = getAnnotatorIdFromToken(token);
    if (!annotatorId) return res.status(403).json({ error: "Invalid token" });

    const { pairId, response, left, right, presentedTime, responseTimeMs } = req.body;

    let attention = req.body.attention || undefined;
    if (attention && typeof attention === "object") {
        if (attention.side !== "left" && attention.side !== "right") {
            attention.side = undefined;
        }

        if (attention.type === "point") {
            if (!attention.coordSpace) attention.coordSpace = "normalised";
            if (attention.coordSpace === "normalised") {
                const clamp01 = (v) => Math.max(0, Math.min(1, Number(v)));
                if (Number.isFinite(attention.x)) attention.x = clamp01(attention.x);
                if (Number.isFinite(attention.y)) attention.y = clamp01(attention.y);
            }
        }
        // else if (attention.type === "box") {}
    }

    const goldPairs = JSON.parse(fs.readFileSync(goldPairsPath));
    const isGold = !!goldPairs.find((g) => g.pair_id === pairId);

    const annotator = await Annotator.findOne({ annotatorId });
    const isRepeat = !isGold && annotator.completedPairs.includes(pairId);
    const repeatOf = isRepeat ? pairId : undefined;

    let computedRt;
    if (presentedTime) {
        const p = new Date(presentedTime).getTime();
        if (!Number.isNaN(p)) computedRt = Date.now() - p;
    }

    // For golds, compute correctness
    let goldExpected, goldCorrect;
    if (isGold) {
        const g = goldPairs.find((g) => g.pair_id === pairId);
        goldExpected = g?.expected;
        goldCorrect = response === goldExpected;
    }
    try {
        await Annotation.create({
            annotatorId,
            pairId,
            response,
            left: { url: left?.url },
            right: { url: right?.url },
            presentedTime: presentedTime ? new Date(presentedTime) : undefined,
            responseTimeMs: Number.isFinite(responseTimeMs) ? responseTimeMs : computedRt,
            attention,
            isGold,
            goldExpected,
            goldCorrect,
            isRepeat,
            repeatOf,
        });
    } catch (err) {
        if (err && err.code === 11000) {
            return res.status(409).json({ error: "Already annotated this original pair" });
        }
        throw err;
    }

    if (!isGold && !isRepeat) {
        // Count only new (non-gold, non-repeat) towards progress
        if (!annotator.completedPairs.includes(pairId)) {
            annotator.completedPairs.push(pairId);
            annotator.completedCount += 1;
            if (Math.random() < REPEAT_RATE && annotator.repeatQueue.length < MAX_REPEAT_QUEUE) {
                annotator.repeatQueue.push({
                    pairId,
                    targetAtCount: annotator.completedCount + REPEAT_GAP,
                });
            }
        }
        await annotator.save();
    }
    res.sendStatus(200);
});

module.exports = router;
