const mongoose = require('mongoose');

const RepeatItem = new mongoose.Schema({
  pairId: String,
  targetAtCount: Number // serve this repeat once annotator.completedCount >= targetAtCount
}, { _id: false });

const AnnotatorSchema = new mongoose.Schema({
  annotatorId: String,
  completedPairs: [String],
  completedCount: { type: Number, default: 0 },
  seenGold: [String],
  repeatQueue: [RepeatItem]
});

module.exports = mongoose.model('Annotator', AnnotatorSchema);