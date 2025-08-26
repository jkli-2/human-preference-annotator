#!/usr/bin/env python3
"""
pair_clips.py — walk a directory, pair video clips by common prefix and agent, and write JSON.

Filename assumptions (customisable via regex below):
  <prefix>__<scenario>__tpre...tpost...__agent<NUM>_<ROUTE>.mp4
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

def extract_grouping_key_from_stem(stem: str) -> str | None:
    """
    Returns grouping key: everything before '__agent' including a trailing '__'.
    If no '__agent' token exists, returns None.
    """
    parts = stem.split("__agent", 1)
    if len(parts) < 2:
        return None
    # Include the trailing '__' to mirror the behaviour of your updated logic
    return parts[0] + "__"

def count_pairs_and_non_paired_groups_for_two_agents(group_map: dict) -> tuple[int, list[str]]:
    """
    Emulates your updated snippet's summary across agent1 and agent2 only.
    group_map: {group_key: { agent: [(route, path, scenario), ...], ... }, ...}
    """
    total_pairs = 0
    non_paired_groups = []

    for group_key, agents in group_map.items():
        a1_count = len(agents.get("agent1", []))
        a2_count = len(agents.get("agent2", []))
        if a1_count > 0 and a2_count > 0:
            total_pairs += a1_count * a2_count
        else:
            non_paired_groups.append(group_key)

    return total_pairs, non_paired_groups

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
    base_key = extract_grouping_key_from_stem(stem) if m_agent else None

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
    ap.add_argument("--report-nonpaired", action="store_true",
                    help="Also print a summary of total one-to-one pairs and non-paired groups (agent1 vs agent2).")
    args = ap.parse_args()

    root = Path(args.root).expanduser().resolve()
    if not root.exists():
        raise SystemExit(f"Root path does not exist: {root}")

    # Group structure: {(base_key): {agent: [(route, path, scenario), ...]}}
    groups: dict[str, dict[str, list[tuple[str | None, str, str | None]]]] = defaultdict(lambda: defaultdict(list))

    total = 0
    skipped = 0
    for p in find_mp4s(root):
        total += 1
        base_key, agent, route, scenario = parse_filename(p.name)
        if not (base_key and agent):
            skipped += 1
            continue
        if args.abs_paths:
            path_str = str(p.resolve())
        else:
            rel = p.relative_to(root)
            path_str = str(Path(args.prefix) / rel) if args.prefix else str(rel)
        groups[base_key][agent].append((route, path_str, scenario))

    # summary
    if args.report_nonpaired:
        total_pairs_like_core, non_paired_groups = count_pairs_and_non_paired_groups_for_two_agents(groups)
        print(f"Total one-to-one pairs (agent1 x agent2, regardless of route): {total_pairs_like_core}")
        if non_paired_groups:
            print("Non-paired groups (only one of agent1/agent2 present):")
            for gk in non_paired_groups:
                print(f"  - {gk}")
        else:
            print("All groups have both agent1 and agent2.")

    # Build pairs.json (existing behaviour preserved)
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
