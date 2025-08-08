const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const Annotator = require("../models/Annotator");
const Annotation = require("../models/Annotation");

const clipPairsPath = path.join(__dirname, "../data/clip_pairs.json");

const tokenData = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/tokens.json")));
const tokenMap = Object.fromEntries(tokenData.map((entry) => [entry.token, entry.annotatorId]));

function getAnnotatorIdFromToken(token) {
    return tokenMap[token] || null;
}

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

router.get("/export", async (req, res) => {
    const annotations = await Annotation.find({});
    const output = annotations.map(({ annotatorId, pairId, response, timestamp }) => ({
        annotator_id: annotatorId,
        pair_id: pairId,
        response,
        timestamp,
    }));
    res.json(output);
});

module.exports = router;
