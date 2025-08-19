const mongoose = require('mongoose');

const AttentionSchema = new mongoose.Schema({
    side: { type: String, enum: ["left","right"] },
    gridIndex: Number,        // 1..9
    row: Number, col: Number, // 0..2
    rect: {                   // normalized to [0,1] in video coords
        x: Number, y: Number, w: Number, h: Number
    },
    decisionAtMs: Number
}, { _id: false });

const AnnotationSchema = new mongoose.Schema({
    annotatorId: String,
    pairId: String,
    response: { type: String, enum: ["left", "right", "cant_tell"], required: true },
    left: { url: String },
    right: { url: String },
    attention: AttentionSchema,
    isGold: { type: Boolean, default: false },
    goldExpected: { type: String, enum: ["left", "right"], required: function(){ return this.isGold; } },
    goldCorrect: { type: Boolean },
    isRepeat: { type: Boolean, default: false },
    repeatOf: { type: String },
    presentedTime: { type: Date },
    timestamp: { type: Date, default: Date.now },
    responseTimeMs: Number, // timestamp - presentedAt
});

// Originals (non-gold, non-repeat) must be unique per annotator/pair
AnnotationSchema.index(
    { annotatorId: 1, pairId: 1 },
    {
        unique: true,
        partialFilterExpression: { isGold: { $ne: true }, isRepeat: { $ne: true } }
    }
);
// for queries/exports
AnnotationSchema.index({ annotatorId: 1, isGold: 1 });
AnnotationSchema.index({ annotatorId: 1, isRepeat: 1, pairId: 1 });

module.exports = mongoose.model('Annotation', AnnotationSchema);