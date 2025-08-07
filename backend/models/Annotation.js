const mongoose = require('mongoose');

const AnnotationSchema = new mongoose.Schema({
  annotatorId: String,
  pairId: String,
  response: String,
  timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Annotation', AnnotationSchema);