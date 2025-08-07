const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const Annotator = require('../models/Annotator');
const Annotation = require('../models/Annotation');

const clipPairsPath = path.join(__dirname, '../data/clip_pairs.json');

router.get('/clip-pairs', async (req, res) => {
  const { annotatorId } = req.query;
  const clipPairs = JSON.parse(fs.readFileSync(clipPairsPath));

  let annotator = await Annotator.findOne({ annotatorId });
  if (!annotator) annotator = await Annotator.create({ annotatorId, completedPairs: [] });

  const nextPair = clipPairs.find(p => !annotator.completedPairs.includes(p.pair_id));
  const progress = {
    completed: annotator.completedPairs.length,
    total: clipPairs.length
  };

  res.json(nextPair ? { ...nextPair, progress } : null);
});

router.post('/annotate', async (req, res) => {
  const { annotatorId, pairId, response } = req.body;
  await Annotation.create({ annotatorId, pairId, response });
  await Annotator.updateOne(
    { annotatorId },
    { $addToSet: { completedPairs: pairId } }
  );
  res.sendStatus(200);
});

router.get('/progress', async (req, res) => {
  const { annotatorId } = req.query;
  const annotator = await Annotator.findOne({ annotatorId });
  const clipPairs = JSON.parse(fs.readFileSync(clipPairsPath));
  res.json({
    annotatorId,
    completed: annotator?.completedPairs.length || 0,
    total: clipPairs.length
  });
});

router.get('/export', async (req, res) => {
  const annotations = await Annotation.find({});
  const output = annotations.map(({ annotatorId, pairId, response, timestamp }) => ({
    annotator_id: annotatorId,
    pair_id: pairId,
    response,
    timestamp
  }));
  res.json(output);
});

module.exports = router;