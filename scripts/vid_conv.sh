#!/bin/bash
INPUT_DIR="frontend/videos/early_late_mi_training"
OUTPUT_DIR="$INPUT_DIR/converted"

mkdir -p "$OUTPUT_DIR"

for f in $INPUT_DIR/*.mp4; do
    [ -e "$f" ] || continue  # skip if no .mp4 files
    filename=$(basename "$f")
    ffmpeg -y -i "$f" \
      -c:v libx264 -pix_fmt yuv420p -profile:v high -level 4.0 \
      -movflags +faststart \
      -preset veryfast -crf 20 \
      -vsync cfr \
      -an \
      "$OUTPUT_DIR/$filename"
done

