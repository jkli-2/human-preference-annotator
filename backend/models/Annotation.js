const mongoose = require("mongoose");

const AttentionSchema = new mongoose.Schema(
  {
    side: { type: String, enum: ["left", "right"] },
    type: { type: String, enum: ["point", "grid", "box"], default: undefined }, // extensible
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

const SideSchema = new mongoose.Schema(
  {
    url: String,
    surprise: {
      type: Number,
      min: 1,
      max: 5,
      required: false,
      validate: {
        validator: function (v) {
          // allow null/undefined if response === 'cant_tell'
          if (this.parent().response === "cant_tell") return v == null;
          // otherwise either undefined (to let API validate) or valid number
          return v == null || (Number.isInteger(v) && v >= 1 && v <= 5);
        },
        message: "surprise must be an integer in [1,5]",
      },
    },
  },
  { _id: false }
);

const AnnotationSchema = new mongoose.Schema({
  annotatorId: String,
  pairId: String,
  response: { type: String, enum: ["left", "right", "cant_tell"], required: true },

  surpriseChoice: { type: String, enum: ["left", "right", "none"], required: false },
  // LEFT/RIGHT also include optional 'surprise'
  left: SideSchema,
  right: SideSchema,

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

  stageDurations: {
    type: Map,
    of: Number,
    required: false,
  },
});

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
