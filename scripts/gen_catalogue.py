#!/usr/bin/env python3
"""
Build a master catalogue (clip_paris.json) for CARLA driving clips.

Expected directory layout (relative to --root):
  video/<scenario>/<variant>/<agent>/<route_id>/clip_###.mp4
e.g.:
  bc1/actor1708008767/3/clip_009.mp4

By default, writes:
  [
    {
      "id": "<uuid5 hash of rel_path>",
      "scenario": "car_following",
      "variant": "bc1",
      "agent": "actor1708008767",
      "route_id": 3,
      "clip_idx": 9,
      "rel_path": "bc1/actor1708008767/3/clip_009.mp4",
      "duration_s": 4.0,
      "fps": 10.0
    },
    ...
  ]

Options:
  --probe uses ffprobe (if available) to read true duration/FPS (OpenCV fallback).
  Otherwise, uses --default-duration and --default-fps.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Optional, Tuple

CLIP_RE = re.compile(r"^clip_(\d{3,}).mp4$", re.IGNORECASE)

def probe_with_ffprobe(path: Path) -> Optional[Tuple[float, float]]:
    try:
        cmd_dur = [
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(path)
        ]
        dur_out = subprocess.check_output(cmd_dur, stderr=subprocess.STDOUT, text=True).strip()
        duration = float(dur_out)

        cmd_fps = [
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=avg_frame_rate",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(path)
        ]
        fps_out = subprocess.check_output(cmd_fps, stderr=subprocess.STDOUT, text=True).strip()
        if "/" in fps_out and fps_out != "0/0":
            num, den = fps_out.split("/")
            fps = (float(num) / float(den)) if float(den) else 0.0
        else:
            fps = float(fps_out)
        if not (0.1 <= fps <= 1000):
            fps = None
        if duration <= 0:
            duration = None
        if duration is None or fps is None:
            return None
        return (duration, fps)
    except Exception:
        return None

def probe_with_opencv(path: Path) -> Optional[Tuple[float, float]]:
    try:
        import cv2  # type: ignore
    except Exception:
        return None
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        cap.release()
        return None
    try:
        fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
        frames = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0.0
        cap.release()
        if fps <= 0.0 or frames <= 0.0:
            return None
        duration = frames / fps
        return (float(duration), float(fps))
    except Exception:
        cap.release()
        return None

def get_duration_fps(path: Path, use_probe: bool, default_duration: float, default_fps: float) -> Tuple[float, float]:
    if not use_probe:
        return (float(default_duration), float(default_fps))
    meta = probe_with_ffprobe(path)
    if meta is None:
        meta = probe_with_opencv(path)
    if meta is None:
        return (float(default_duration), float(default_fps))
    return meta

def stable_uuid_for(rel_path: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, rel_path))

def build_entry(rel_path: Path, default_duration: float, default_fps: float, use_probe: bool):
    # rel_path: <scenario>/<variant>/<agent>/<route_id>/clip_###.mp4
    parts = rel_path.parts
    if len(parts) < 5:
        raise ValueError(f"Unexpected path layout: {rel_path}")
    scenario = parts[0]
    variant = parts[1]
    agent = parts[2]
    try:
        route_id = int(parts[3])
    except ValueError:
        raise ValueError(f"Route folder is not an integer: {rel_path}")
    fname = parts[-1]
    m = CLIP_RE.match(fname)
    if not m:
        raise ValueError(f"Filename does not match clip_###.mp4: {rel_path}")
    clip_idx = int(m.group(1))

    duration_s, fps = get_duration_fps(rel_path, use_probe, default_duration, default_fps)

    return {
        "id": stable_uuid_for(str(rel_path).replace(os.sep, "/")),
        "scenario": scenario,
        "variant": variant,
        "agent": agent,
        "route_id": route_id,
        "clip_idx": clip_idx,
        "rel_path": str(rel_path).replace(os.sep, "/"),
        "duration_s": round(float(duration_s), 6),
        "fps": float(fps),
    }

def scan(root: Path) -> list[Path]:
    """Return all .mp4 files under: <scenario>/<variant>/<agent>/<route_id>/clip_*.mp4"""
    paths = []
    for scen_dir in sorted([p for p in root.iterdir() if p.is_dir()]):
        for variant_dir in sorted([p for p in scen_dir.iterdir() if p.is_dir()]):
            for agent_dir in sorted([p for p in variant_dir.iterdir() if p.is_dir()]):
                for route_dir in sorted([p for p in agent_dir.iterdir() if p.is_dir()]):
                    for clip in sorted(route_dir.glob("clip_*.mp4")):
                        paths.append(clip.relative_to(root))
    return paths

def main():
    ap = argparse.ArgumentParser(description="Generate master catalogue clip_paris.json")
    ap.add_argument("--root", type=Path, default=Path("video"), help="Dataset root containing scenario/variant/agent/route directories")
    ap.add_argument("--out", type=Path, default=Path("clip_paris.json"), help="Output JSON file")
    ap.add_argument("--default-duration", type=float, default=4.0, help="Fallback duration (s) when not probing")
    ap.add_argument("--default-fps", type=float, default=10.0, help="Fallback FPS when not probing")
    ap.add_argument("--probe", action="store_true", help="Probe video files for true duration/FPS")
    args = ap.parse_args()

    root = args.root.resolve()
    if not root.exists():
        print(f"[ERROR] Root not found: {root}", file=sys.stderr)
        sys.exit(1)

    rel_paths = scan(root)
    if not rel_paths:
        print(f"[WARN] No clips found under {root}", file=sys.stderr)

    entries = []
    for rp in rel_paths:
        try:
            entry = build_entry(
                rp,
                default_duration=args.default_duration,
                default_fps=args.default_fps,
                use_probe=args.probe,
            )
            entries.append(entry)
        except Exception as e:
            print(f"[SKIP] {rp}: {e}", file=sys.stderr)

    entries.sort(key=lambda e: (e["scenario"], e["variant"], e["agent"], e["route_id"], e["clip_idx"]))

    args.out.write_text(json.dumps(entries, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(entries)} entries to {args.out}")

if __name__ == "__main__":
    main()
