"""Score busy stop pairs by the pedestrian route between the two sides."""

import csv
from concurrent.futures import ThreadPoolExecutor, as_completed

from aws_geo import route
from lib import DATA, WALK_METRES_PER_MIN, write_json

WORKERS = 4


def load_busy():
    with (DATA / "pairs.csv").open(encoding="utf-8", newline="") as handle:
        return [row for row in csv.DictReader(handle) if int(row["arrivals"]) >= 400]


def score_pair(pair):
    walked = route(
        (float(pair["lon_a"]), float(pair["lat_a"])),
        (float(pair["lon_b"]), float(pair["lat_b"])),
        "Pedestrian",
    )
    straight = float(pair["straight_m"])
    walk_m = float(walked["distance_m"] or 0)
    extra_m = max(0.0, walk_m - straight)
    arrivals = int(pair["arrivals"])
    extra_min = round(extra_m / WALK_METRES_PER_MIN, 2)
    is_gap = extra_m > 150 and walk_m >= straight * 3
    return {
        "pair_id": pair["pair_id"],
        "name": pair["name"],
        "same_name": pair["same_name"] == "true",
        "lon": float(pair["lon"]),
        "lat": float(pair["lat"]),
        "straight_m": straight,
        "walk_m": round(walk_m, 1),
        "extra_m": round(extra_m, 1),
        "duration_s": walked["duration_s"],
        "extra_min": extra_min,
        "arrivals": arrivals,
        "impact": round(extra_min * arrivals, 1),
        "is_gap": is_gap,
        "name_a": pair["name_a"],
        "name_b": pair["name_b"],
        "desc_a": pair["desc_a"],
        "desc_b": pair["desc_b"],
    }


def main():
    pairs = load_busy()
    print(f"routing {len(pairs)} pairs", flush=True)
    scored = []
    failures = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(score_pair, pair): pair for pair in pairs}
        for done, future in enumerate(as_completed(futures), start=1):
            pair = futures[future]
            try:
                scored.append(future.result())
            except Exception as error:
                failures += 1
                print(f"fail {pair['name']}: {error}", flush=True)
            if done % 25 == 0 or done == len(pairs):
                print(f"{done}/{len(pairs)}", flush=True)
    scored.sort(key=lambda row: row["impact"], reverse=True)
    out = DATA / "scored_pairs.jsonl"
    with out.open("w", encoding="utf-8") as handle:
        for row in scored:
            handle.write(__import__("json").dumps(row, ensure_ascii=False) + "\n")
    gaps = [row for row in scored if row["is_gap"]]
    summary = {
        "detector": "pedestrian_route",
        "routed": len(scored),
        "failures": failures,
        "gaps": len(gaps),
        "top": [
            {
                "name": row["name"],
                "arrivals": row["arrivals"],
                "straight_m": row["straight_m"],
                "walk_m": row["walk_m"],
                "extra_min": row["extra_min"],
                "impact": row["impact"],
            }
            for row in gaps[:15]
        ],
    }
    write_json(DATA / "score_summary.json", summary)
    print(summary, flush=True)


if __name__ == "__main__":
    main()
