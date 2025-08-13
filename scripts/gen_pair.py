#!/usr/bin/env python3
"""
Generate clip_pairs.json from a flat catalogue of clips.

Input:  catalogue.json  (list of entries with fields at least:
        scenario, variant, agent, route_id, clip_idx, rel_path)

Output: clip_pairs.json (list of pair records like:
        { "pair_id": "000001", "left_clip": "...", "right_clip": "...", "description": "<scenario>" })

Pairing strategies (choose with --strategy):
  A = Cross-agent, same variant           -> key: (scenario, variant, route_id, clip_idx), pair over agents
  B = Cross-variant, same agent           -> key: (scenario, agent, route_id, clip_idx), pair over variants
  C = Baseline-vs-challenger (per variant)-> key: (scenario, variant, route_id, clip_idx), pivot one agent per variant
  D = Tournament sampling (k agents)      -> key: (scenario, variant, route_id, clip_idx), sample k agents then pair

Notes:
- Only clips that actually exist in both sides of a key are paired (sparse folders safe).
- Description is placeholder = scenario label (you can post-process later).
- Use --path-prefix to prepend e.g. "video/" to each rel_path in the output.

Usage:

A) Cross-agent, same variant (clean policy comparisons)

python gen_pair.py \
  --catalogue catalogue.json \
  --out clip_pairs.json \
  --strategy A \
  --path-prefix video

B) Cross-variant, same agent (control for driver identity)

python gen_pair.py \
  --catalogue catalogue.json \
  --out clip_pairs.json \
  --strategy B \
  --path-prefix video

C) Baseline vs challenger (per variant)
Pick/confirm a baseline agent for each variant (or the script will use the lexicographically smallest agent where needed):

# With explicit baselines
echo '{"bc1":"actor1708000000","vanilla1":"actor1709000000"}' > pivots.json

python gen_pair.py \
  --catalogue catalogue.json \
  --out clip_pairs.json \
  --strategy C \
  --pivot-json pivots.json \
  --path-prefix video

D) Tournament sampling (diverse, bounded)

python gen_pair.py \
  --catalogue catalogue.json \
  --out clip_pairs.json \
  --strategy D \
  --k 4 \
  --seed 123 \
  --path-prefix video
"""

import argparse
import itertools
import json
from pathlib import Path
from collections import defaultdict
import random
import sys

def load_catalogue(path: Path):
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    # minimal validation
    required = {"scenario","variant","agent","route_id","clip_idx","rel_path"}
    for i, e in enumerate(data):
        missing = required - set(e)
        if missing:
            raise ValueError(f"Entry {i} missing fields: {missing}")
    return data

def norm_path(rel_path: str, prefix: str | None) -> str:
    if not prefix:
        return rel_path
    # ensure exactly one separator when joining
    return f"{prefix.rstrip('/')}/{rel_path.lstrip('/')}"

def pairwise_combinations(items):
    """All unordered pairs from a list, each pair sorted for determinism."""
    out = []
    for a, b in itertools.combinations(items, 2):
        out.append(tuple(sorted((a, b))))
    return out

def next_pair_id(n: int, width: int = 6) -> str:
    return str(n).zfill(width)

def build_pairs_strategy_A(rows):
    """Cross-agent within same variant."""
    groups = defaultdict(list)  # key -> list of rows
    for r in rows:
        key = (r["scenario"], r["variant"], r["route_id"], r["clip_idx"])
        groups[key].append(r)
    pairs = []
    for key, group in groups.items():
        # group by agent; ensure single clip per agent per key
        by_agent = {}
        for r in group:
            by_agent[r["agent"]] = r
        # unordered agent pairs
        agent_pairs = pairwise_combinations(list(by_agent.keys()))
        for a1, a2 in agent_pairs:
            pairs.append((by_agent[a1], by_agent[a2]))
    return pairs

def build_pairs_strategy_B(rows):
    """Cross-variant for same agent."""
    groups = defaultdict(list)  # key -> rows
    for r in rows:
        key = (r["scenario"], r["agent"], r["route_id"], r["clip_idx"])
        groups[key].append(r)
    pairs = []
    for key, group in groups.items():
        # by variant
        by_variant = {}
        for r in group:
            by_variant[r["variant"]] = r
        variant_pairs = pairwise_combinations(list(by_variant.keys()))
        for v1, v2 in variant_pairs:
            pairs.append((by_variant[v1], by_variant[v2]))
    return pairs

def build_pairs_strategy_C(rows, pivot_map: dict | None):
    """
    Baseline vs challenger (per variant).
    pivot_map: optional dict mapping variant -> baseline agent.
    If unspecified, pick lexicographically smallest agent present for that (scenario, variant).
    """
    # index rows per (scenario, variant, route_id, clip_idx, agent)
    index = defaultdict(dict)  # key -> agent -> row
    agents_per_sv = defaultdict(set)  # (scenario, variant) -> {agents}
    for r in rows:
        k = (r["scenario"], r["variant"], r["route_id"], r["clip_idx"])
        index[k][r["agent"]] = r
        agents_per_sv[(r["scenario"], r["variant"])].add(r["agent"])

    pairs = []
    for k, by_agent in index.items():
        scen, variant, route_id, clip_idx = k
        # pick pivot agent
        pivot = None
        if pivot_map and variant in pivot_map:
            if pivot_map[variant] in agents_per_sv[(scen, variant)]:
                pivot = pivot_map[variant]
        if pivot is None:
            pivot = sorted(agents_per_sv[(scen, variant)])[0]
        if pivot not in by_agent:
            # pivot missing this specific (route, clip); skip
            continue
        base_row = by_agent[pivot]
        for agent, row in by_agent.items():
            if agent == pivot:
                continue
            # pair baseline with every other agent that has this clip
            # keep deterministic order: (baseline, challenger)
            pairs.append((base_row, row))
    return pairs

def build_pairs_strategy_D(rows, k: int, rng: random.Random):
    """Tournament sampling: within each (scenario, variant, route_id, clip_idx), sample k agents then pair all among them."""
    groups = defaultdict(list)
    for r in rows:
        key = (r["scenario"], r["variant"], r["route_id"], r["clip_idx"])
        groups[key].append(r)
    pairs = []
    for key, group in groups.items():
        by_agent = {}
        for r in group:
            by_agent[r["agent"]] = r
        agents = list(by_agent.keys())
        if len(agents) < 2:
            continue
        if len(agents) > k:
            agents = rng.sample(agents, k)
        # all pairs among the sampled agents
        for a1, a2 in pairwise_combinations(sorted(agents)):
            pairs.append((by_agent[a1], by_agent[a2]))
    return pairs

def main():
    ap = argparse.ArgumentParser(description="Generate clip_pairs.json from catalogue.json")
    ap.add_argument("--catalogue", type=Path, default=Path("catalogue.json"))
    ap.add_argument("--out", type=Path, default=Path("clip_pairs.json"))
    ap.add_argument("--strategy", choices=list("ABCD"), default="A")
    ap.add_argument("--path-prefix", type=str, default="video", help="Prefix to prepend to rel_path in output ('' to disable)")
    # Strategy C options
    ap.add_argument("--pivot-json", type=Path, help='JSON mapping of variant -> baseline agent (e.g., {"bc1":"actorA"} )')
    # Strategy D options
    ap.add_argument("--k", type=int, default=4, help="Tournament sample size (strategy D)")
    ap.add_argument("--seed", type=int, default=42, help="Random seed (strategy D)")
    # Misc
    ap.add_argument("--id-width", type=int, default=6, help="Zero-pad width for pair_id")
    args = ap.parse_args()

    rows = load_catalogue(args.catalogue)

    # build pairs according to strategy
    if args.strategy == "A":
        pairs = build_pairs_strategy_A(rows)
    elif args.strategy == "B":
        pairs = build_pairs_strategy_B(rows)
    elif args.strategy == "C":
        pivot_map = None
        if args.pivot_json:
            with args.pivot_json.open("r", encoding="utf-8") as f:
                pivot_map = json.load(f)
        pairs = build_pairs_strategy_C(rows, pivot_map)
    elif args.strategy == "D":
        rng = random.Random(args.seed)
        pairs = build_pairs_strategy_D(rows, k=args.k, rng=rng)
    else:
        print(f"Unknown strategy: {args.strategy}", file=sys.stderr)
        sys.exit(2)

    # Deduplicate pairs across groups by using (left_rel,right_rel,scenario) as a key.
    # Use deterministic left/right ordering:
    out_pairs = []
    seen = set()
    counter = 1
    for r1, r2 in pairs:
        # decide left/right with a stable tiebreaker
        # Priority: (variant, agent, route_id, clip_idx, rel_path)
        key1 = (r1["variant"], r1["agent"], r1["route_id"], r1["clip_idx"], r1["rel_path"])
        key2 = (r2["variant"], r2["agent"], r2["route_id"], r2["clip_idx"], r2["rel_path"])
        left, right = (r1, r2) if key1 <= key2 else (r2, r1)

        left_path  = norm_path(left["rel_path"], args.path_prefix) if args.path_prefix is not None else left["rel_path"]
        right_path = norm_path(right["rel_path"], args.path_prefix) if args.path_prefix is not None else right["rel_path"]

        # dedupe key
        sig = (left_path, right_path, left["scenario"])
        if sig in seen:
            continue
        seen.add(sig)

        out_pairs.append({
            "pair_id": next_pair_id(counter, width=args.id_width),
            "left_clip": left_path,
            "right_clip": right_path,
            "description": left["scenario"],  # placeholder per your note
        })
        counter += 1

    # Write output
    args.out.write_text(json.dumps(out_pairs, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(out_pairs)} pairs to {args.out}")

if __name__ == "__main__":
    main()
