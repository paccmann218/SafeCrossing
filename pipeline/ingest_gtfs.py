"""Build opposite-side BMTC stop pairs and count scheduled arrivals."""

import csv
import io
import zipfile
from collections import defaultdict

from lib import DATA, PAIR_MAX_M, PAIR_MIN_M, RAW, haversine_m, midpoint, write_json

GTFS_ZIP = RAW / "bmtc.zip"
PAIRS_CSV = DATA / "pairs.csv"


def load_stops():
    with zipfile.ZipFile(GTFS_ZIP) as archive:
        text = io.TextIOWrapper(archive.open("stops.txt"), encoding="utf-8")
        stops = []
        for row in csv.DictReader(text):
            stops.append(
                {
                    "id": row["stop_id"],
                    "name": row["stop_name"].strip(),
                    "desc": (row.get("stop_desc") or "").strip(),
                    "lat": float(row["stop_lat"]),
                    "lon": float(row["stop_lon"]),
                    "parent": (row.get("parent_station") or "").strip(),
                }
            )
    return stops


def count_arrivals():
    counts = defaultdict(int)
    with zipfile.ZipFile(GTFS_ZIP) as archive:
        text = io.TextIOWrapper(archive.open("stop_times.txt"), encoding="utf-8")
        for row in csv.DictReader(text):
            counts[row["stop_id"]] += 1
    return counts


def nearest_pairs(stops):
    cell = 0.0012
    grid = defaultdict(list)
    for index, stop in enumerate(stops):
        grid[(int(stop["lon"] / cell), int(stop["lat"] / cell))].append(index)

    chosen = {}
    for index, stop in enumerate(stops):
        cx, cy = int(stop["lon"] / cell), int(stop["lat"] / cell)
        best = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for other_index in grid[(cx + dx, cy + dy)]:
                    if other_index == index:
                        continue
                    other = stops[other_index]
                    if stop["parent"] and stop["parent"] == other["parent"]:
                        continue
                    dist = haversine_m(stop["lon"], stop["lat"], other["lon"], other["lat"])
                    if PAIR_MIN_M <= dist <= PAIR_MAX_M and (best is None or dist < best[0]):
                        best = (dist, other_index)
        if best:
            chosen[index] = best

    pairs = {}
    for index, (dist, other_index) in chosen.items():
        left, right = sorted((index, other_index))
        key = (stops[left]["id"], stops[right]["id"])
        if key not in pairs or dist < pairs[key][0]:
            pairs[key] = (dist, left, right)
    return pairs


def main():
    print("reading stops")
    stops = load_stops()
    print(f"stops {len(stops)}")
    print("counting arrivals")
    arrivals = count_arrivals()
    print(f"stops with arrivals {len(arrivals)}")
    pairs = nearest_pairs(stops)
    print(f"pairs {len(pairs)}")

    PAIRS_CSV.parent.mkdir(parents=True, exist_ok=True)
    same_name = 0
    with PAIRS_CSV.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "pair_id",
                "name",
                "same_name",
                "lon",
                "lat",
                "straight_m",
                "arrivals",
                "arrivals_a",
                "arrivals_b",
                "stop_a",
                "stop_b",
                "name_a",
                "name_b",
                "desc_a",
                "desc_b",
                "lon_a",
                "lat_a",
                "lon_b",
                "lat_b",
            ],
        )
        writer.writeheader()
        for (id_a, id_b), (dist, left, right) in pairs.items():
            a, b = stops[left], stops[right]
            shared = a["name"].casefold() == b["name"].casefold()
            if shared:
                same_name += 1
            lon, lat = midpoint(a["lon"], a["lat"], b["lon"], b["lat"])
            writer.writerow(
                {
                    "pair_id": f"{id_a}-{id_b}",
                    "name": a["name"] if shared else f"{a['name']} / {b['name']}",
                    "same_name": "true" if shared else "false",
                    "lon": round(lon, 6),
                    "lat": round(lat, 6),
                    "straight_m": round(dist, 1),
                    "arrivals": arrivals[a["id"]] + arrivals[b["id"]],
                    "arrivals_a": arrivals[a["id"]],
                    "arrivals_b": arrivals[b["id"]],
                    "stop_a": a["id"],
                    "stop_b": b["id"],
                    "name_a": a["name"],
                    "name_b": b["name"],
                    "desc_a": a["desc"],
                    "desc_b": b["desc"],
                    "lon_a": a["lon"],
                    "lat_a": a["lat"],
                    "lon_b": b["lon"],
                    "lat_b": b["lat"],
                }
            )
    summary = {
        "stops": len(stops),
        "pairs": len(pairs),
        "same_name_pairs": same_name,
        "service": "The September 2026 BMTC feed publishes one service that runs every day, so this count is scheduled arrivals per day.",
    }
    write_json(DATA / "ingest_summary.json", summary)
    print(summary)


if __name__ == "__main__":
    main()
