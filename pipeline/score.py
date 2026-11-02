"""Score each stop pair by its distance to the nearest mapped crossing."""

import csv
from collections import defaultdict

from lib import DATA, GAP_MIN_M, WALK_METRES_PER_MIN, haversine_m, read_json, write_json

SEARCH_CELLS = 4
CELL = 0.01


def load_pairs():
    with (DATA / "pairs.csv").open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def load_crossings():
    points = read_json(DATA / "osm_crossings.json")["points"]
    grid = defaultdict(list)
    for point in points:
        grid[(int(point["lon"] / CELL), int(point["lat"] / CELL))].append(point)
    return grid


def nearest(grid, lon, lat):
    cx, cy = int(lon / CELL), int(lat / CELL)
    best = None
    best_kind = None
    for dx in range(-SEARCH_CELLS, SEARCH_CELLS + 1):
        for dy in range(-SEARCH_CELLS, SEARCH_CELLS + 1):
            for point in grid.get((cx + dx, cy + dy), ()):
                dist = haversine_m(lon, lat, point["lon"], point["lat"])
                if best is None or dist < best:
                    best = dist
                    best_kind = point["kind"]
    return best, best_kind


def main():
    pairs = load_pairs()
    grid = load_crossings()
    scored = []
    missing = 0
    for pair in pairs:
        lon, lat = float(pair["lon"]), float(pair["lat"])
        dist, kind = nearest(grid, lon, lat)
        if dist is None:
            missing += 1
            continue
        dist = round(dist, 1)
        arrivals = int(pair["arrivals"])
        extra_min = round(dist / WALK_METRES_PER_MIN, 2)
        scored.append(
            {
                **pair,
                "straight_m": float(pair["straight_m"]),
                "arrivals": arrivals,
                "arrivals_a": int(pair["arrivals_a"]),
                "arrivals_b": int(pair["arrivals_b"]),
                "lon": lon,
                "lat": lat,
                "nearest_crossing_m": dist,
                "nearest_crossing_kind": kind,
                "extra_min": extra_min,
                "impact": round(extra_min * arrivals, 1),
                "is_gap": dist >= GAP_MIN_M,
            }
        )
    scored.sort(key=lambda row: row["impact"], reverse=True)
    out = DATA / "scored_pairs.jsonl"
    with out.open("w", encoding="utf-8") as handle:
        for row in scored:
            handle.write(json_line(row))
    gaps = [row for row in scored if row["is_gap"]]
    busy = [row for row in gaps if row["arrivals"] >= 400]
    summary = {
        "pairs_scored": len(scored),
        "no_crossing_within_search": missing,
        "gaps_150m": len(gaps),
        "gaps_150m_and_400_arrivals": len(busy),
        "top": [
            {
                "name": row["name"],
                "arrivals": row["arrivals"],
                "nearest_crossing_m": row["nearest_crossing_m"],
                "impact": row["impact"],
            }
            for row in busy[:10]
        ],
    }
    write_json(DATA / "score_summary.json", summary)
    print(summary)


def json_line(row):
    import json

    return json.dumps(row, ensure_ascii=False) + "\n"


if __name__ == "__main__":
    main()
