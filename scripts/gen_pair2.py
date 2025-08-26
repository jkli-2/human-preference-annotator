#!/usr/bin/env python3
"""
pair_clips.py — walk a directory, pair video clips by common prefix and agent, and write JSON.

Filename assumptions (customisable via regex below):
  <prefix>__<scenario>__tpre...tpost...__agent<NUM>_<ROUTE>.mp4

Examples:
  ckpt_11833344_..._collisions_vehicle__tpre2_tpost2__agent1_552.mp4
  ckpt_11833344_..._collisions_vehicle__tpre2_tpost2__agent2_552.mp4

Default behaviour:
- Group by 'base_key' = everything before the first "__agent"
- Extract agent as "agent<digits>"
- Extract route id as digits after agent
- Extract scenario from the segment immediately before the first "__tpre" or "__tpost"
- Only pair files from different agents; by default requires SAME route id (can disable with --no-require-same-route)

Usage:
  python pair_clips.py /path/to/root --out generated_clip_pairs.json
  python pair_clips.py . --out pairs.json --no-require-same-route
  python pair_clips.py /data --out pairs.json --abs-paths
"""

import argparse
import json
import re
from pathlib import Path
from itertools import combinations
from collections import defaultdict

# ---------- Tunable patterns ----------
RE_AGENT = re.compile(r"__agent(\d+)_")
RE_ROUTE = re.compile(r"__agent\d+_(\d+)$")
# Scenario: take the chunk right before __tpre / __tpost, then grab its trailing alpha/underscore run
RE_TBLOCK = re.compile(r"__(tpre|tpost)", re.IGNORECASE)
RE_SCENARIO_TAIL = re.compile(r"([A-Za-z]+(?:_[A-Za-z]+)*)$")

def parse_filename(basename: str):
    """
    Returns (base_key, agent, route_id, scenario) or (None, None, None, None) on failure.
    """
    if not basename.lower().endswith(".mp4"):
        return (None, None, None, None)

    stem = basename[:-4]

    # agent
    m_agent = RE_AGENT.search(stem)
    agent = f"agent{m_agent.group(1)}" if m_agent else None

    # route
    m_route = RE_ROUTE.search(stem)
    route = m_route.group(1) if m_route else None

    # base key
    base_key = stem.split("__agent")[0] if m_agent else None

    # scenario
    scenario = None
    # find the first __tpre/__tpost occurrence and take the chunk immediately before it
    tblock = RE_TBLOCK.search(stem)
    if tblock:
        # split by "__" and locate the tblock token index
        parts = stem.split("__")
        idx = None
        for i, p in enumerate(parts):
            if p.lower().startswith("tpre") or p.lower().startswith("tpost"):
                idx = i
                break
        if idx is not None and idx - 1 >= 0:
            candidate = parts[idx - 1]
            m_tail = RE_SCENARIO_TAIL.search(candidate)
            if m_tail:
                scenario = m_tail.group(1)

    return (base_key, agent, route, scenario)

def find_mp4s(root: Path):
    for p in root.rglob("*.mp4"):
        if p.is_file():
            yield p

def main():
    ap = argparse.ArgumentParser(description="Generate JSON pairs for clip files with agent variants.")
    ap.add_argument("root", type=str, help="Root directory to scan recursively")
    ap.add_argument("--prefix", type=str, default="", 
                help="Optional prefix to prepend to each clip path in JSON")
    ap.add_argument("--out", type=str, default="generated_clip_pairs.json", help="Output JSON path")
    ap.add_argument("--abs-paths", action="store_true", help="Write absolute file paths in JSON")
    ap.add_argument("--no-require-same-route", action="store_true",
                    help="Pair across agents even if the route ids differ")
    ap.add_argument("--pretty", action="store_true", help="Pretty-print JSON with indentation")
    args = ap.parse_args()

    root = Path(args.root).expanduser().resolve()
    if not root.exists():
        raise SystemExit(f"Root path does not exist: {root}")

    # Group structure: {(base_key): {agent: [(route, path, scenario), ...]}}
    groups = defaultdict(lambda: defaultdict(list))

    total = 0
    skipped = 0
    for p in find_mp4s(root):
        total += 1
        base_key, agent, route, scenario = parse_filename(p.name)
        if not (base_key and agent):
            skipped += 1
            continue
        # path_str = str(p.resolve() if args.abs_paths else p.relative_to(root))
        if args.abs_paths:
            path_str = str(p.resolve())
        else:
            rel = p.relative_to(root)  # e.g. "scenario/file.mp4"
            if args.prefix:
                path_str = str(Path(args.prefix) / rel)  # prepend your prefix
            else:
                path_str = str(rel)
        groups[base_key][agent].append((route, path_str, scenario))

    pairs = []
    pair_counter = 1

    # For each base_key, pair across agents
    for base_key, agent_map in groups.items():
        agents = sorted(agent_map.keys())
        for a1, a2 in combinations(agents, 2):
            left_list = agent_map[a1]
            right_list = agent_map[a2]

            if args.no_require_same_route:
                # all-vs-all across these two agents
                for (_r1, left_path, scen1) in left_list:
                    for (_r2, right_path, scen2) in right_list:
                        scenario = scen1 or scen2 or "unknown_scenario"
                        pairs.append({
                            "pair_id": f"{pair_counter:06d}",
                            "left_clip": left_path,
                            "right_clip": right_path,
                            "description": scenario
                        })
                        pair_counter += 1
            else:
                # match only when route ids are equal (and not None)
                # Build dict from route -> list of paths for each agent
                by_route_left = defaultdict(list)
                by_route_right = defaultdict(list)
                scen_for_route = {}

                for (r, path, scen) in left_list:
                    if r:
                        by_route_left[r].append((path, scen))
                        scen_for_route.setdefault(r, scen)
                for (r, path, scen) in right_list:
                    if r:
                        by_route_right[r].append((path, scen))
                        scen_for_route.setdefault(r, scen_for_route.get(r) or scen)

                # For each route present in both agents, do Cartesian product
                for r in sorted(set(by_route_left.keys()) & set(by_route_right.keys()), key=lambda x: (len(x), x)):
                    for (lp, scen1) in by_route_left[r]:
                        for (rp, scen2) in by_route_right[r]:
                            scenario = scen_for_route.get(r) or scen1 or scen2 or "unknown_scenario"
                            pairs.append({
                                "pair_id": f"{pair_counter:06d}",
                                "left_clip": lp,
                                "right_clip": rp,
                                "description": scenario
                            })
                            pair_counter += 1

    out_path = Path(args.out).expanduser().resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if args.pretty:
        out_path.write_text(json.dumps(pairs, indent=2), encoding="utf-8")
    else:
        out_path.write_text(json.dumps(pairs, separators=(",", ":")), encoding="utf-8")

    print(f"Scanned: {total} files; Skipped (unparsable): {skipped}; Groups: {len(groups)}; Pairs: {len(pairs)}")
    print(f"Wrote: {out_path}")

if __name__ == "__main__":
    main()
