const mongoose = require("mongoose");

const AttentionSchema = new mongoose.Schema(
    {
        side: { type: String, enum: ["left", "right"] },
        type: { type: String, enum: ["point", "grid", "box"], default: undefined }, // for extensibility
        x: { type: Number, min: 0, max: 1 }, // normalised [0,1] when coordSpace === 'normalised'
        y: { type: Number, min: 0, max: 1 },
        coordSpace: {
            type: String,
            enum: ["normalised", "pixel", "cssPixels"],
            default: "normalised",
        },
        decisionAtMs: Number,
    },
    { _id: false }
);

const AnnotationSchema = new mongoose.Schema({
    annotatorId: String,
    pairId: String,
    response: { type: String, enum: ["left", "right", "cant_tell"], required: true },
    left: { url: String },
    right: { url: String },
    attention: AttentionSchema,
    isGold: { type: Boolean, default: false },
    goldExpected: {
        type: String,
        enum: ["left", "right"],
        required: function () {
            return this.isGold;
        },
    },
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
        partialFilterExpression: { isGold: { $ne: true }, isRepeat: { $ne: true } },
    }
);
// for queries/exports
AnnotationSchema.index({ annotatorId: 1, isGold: 1 });
AnnotationSchema.index({ annotatorId: 1, isRepeat: 1, pairId: 1 });

module.exports = mongoose.model("Annotation", AnnotationSchema);
