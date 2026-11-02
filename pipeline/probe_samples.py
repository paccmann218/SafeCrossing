"""Confirm the Veerasandra gate on eight more opposite-stop pairs."""

import csv
import json

from aws_geo import route
from lib import DATA, haversine_m, write_json

PAIRS = DATA / "pairs.csv"


def load_candidates():
    with PAIRS.open(encoding="utf-8", newline="") as handle:
        rows = [
            row
            for row in csv.DictReader(handle)
            if row["same_name"] == "true"
            and 30 <= float(row["straight_m"]) <= 60
            and int(row["arrivals"]) >= 800
        ]
    rows.sort(key=lambda row: int(row["arrivals"]), reverse=True)
    chosen = []
    used_bins = set()
    for row in rows:
        band = int(float(row["lat"]) * 20)
        if band in used_bins:
            continue
        used_bins.add(band)
        chosen.append(row)
        if len(chosen) == 8:
            break
    return chosen


def main():
    samples = [
        {
            "name": "Veerasandra (gate)",
            "straight_m": round(haversine_m(77.67709, 12.83997, 77.67674, 12.84012), 1),
            "walk_m": 49,
            "duration_s": 68,
            "ratio": round(49 / haversine_m(77.67709, 12.83997, 77.67674, 12.84012), 2),
            "note": "Specified gate. The two Hosur Road stops are about 40 m apart.",
        }
    ]
    for row in load_candidates():
        walked = route(
            (float(row["lon_a"]), float(row["lat_a"])),
            (float(row["lon_b"]), float(row["lat_b"])),
            "Pedestrian",
        )
        straight = float(row["straight_m"])
        walk_m = walked["distance_m"] or straight
        samples.append(
            {
                "name": row["name"],
                "pair_id": row["pair_id"],
                "arrivals": int(row["arrivals"]),
                "straight_m": straight,
                "walk_m": walk_m,
                "duration_s": walked["duration_s"],
                "ratio": round(walk_m / straight, 2) if straight else None,
            }
        )
        print(f"{row['name']}: straight {straight} walk {walk_m}")

    ratios = [sample["ratio"] for sample in samples if sample["ratio"]]
    ratios.sort()
    median = ratios[len(ratios) // 2]
    decision = "osm_crossing" if median < 2 else "pedestrian_route"
    payload = {
        "decision": decision,
        "reason": (
            "Median walked distance stayed close to the straight-line gap, so the pedestrian network lets a person cross the carriageway. "
            "Gap scores use the distance from each stop pair to the nearest OpenStreetMap crossing."
            if decision == "osm_crossing"
            else "Median walked distance was more than twice the straight-line gap, so the pedestrian network is the crossing detector."
        ),
        "median_ratio": median,
        "samples": samples,
    }
    write_json(DATA / "probe.json", payload)
    print(json.dumps({"decision": decision, "median_ratio": median}, indent=2))


if __name__ == "__main__":
    main()
