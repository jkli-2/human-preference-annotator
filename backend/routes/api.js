const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const Annotator = require("../models/Annotator");
const Annotation = require("../models/Annotation");

const clipPairsPath = path.join(__dirname, "../data/clip_pairs.json");
const tokenPath = path.join(__dirname, "../data/tokens.json");

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
        console.log(password)
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

router.get('/admin/tokens', requireAdmin, (req, res) => {
  res.json(loadTokens());
});

router.get("/admin/export", requireAdmin, async (req, res) => {
    const annotations = await Annotation.find({});
    const output = annotations.map(({ annotatorId, pairId, response, timestamp }) => ({
        annotator_id: annotatorId,
        pair_id: pairId,
        response,
        timestamp,
    }));
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
    let annotator = await Annotator.findOne({ annotatorId });
    if (!annotator) annotator = await Annotator.create({ annotatorId, completedPairs: [] });
    const nextPair = clipPairs.find((p) => !annotator.completedPairs.includes(p.pair_id));
    const progress = {
        annotatorId: annotator.annotatorId,
        completed: annotator.completedPairs.length,
        total: clipPairs.length,
    };
    res.json(nextPair ? { ...nextPair, progress } : null);
});

router.post("/annotate", async (req, res) => {
    const token = req.body.token;
    const annotatorId = getAnnotatorIdFromToken(token);
    if (!annotatorId) return res.status(403).json({ error: "Invalid token" });

    const { pairId, response } = req.body;
    await Annotation.create({ annotatorId, pairId, response });
    await Annotator.updateOne({ annotatorId }, { $addToSet: { completedPairs: pairId } });
    res.sendStatus(200);
});

module.exports = router;
