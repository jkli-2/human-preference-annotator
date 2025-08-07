const mongoose = require('mongoose');

const AnnotatorSchema = new mongoose.Schema({
  annotatorId: String,
  completedPairs: [String]
});

module.exports = mongoose.model('Annotator', AnnotatorSchema);