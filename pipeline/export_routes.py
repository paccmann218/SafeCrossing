"""Export the walked pedestrian route for every gap, read from the route cache.

The map draws these lines when someone opens a crossing, so the detour is visible
instead of only described. No new Amazon Location calls are made: every route was
already fetched by score_routes.py and sits in data/route_cache.jsonl.
"""

import csv
import hashlib
import json

from lib import DATA, WEB_DATA, write_json

CACHE = DATA / "route_cache.jsonl"


def cache_key(payload):
    blob = {"service": "geo-routes", "command": "calculate-routes", "payload": payload}
    return hashlib.sha256(json.dumps(blob, sort_keys=True).encode()).hexdigest()


def load_cache():
    found = {}
    with CACHE.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                row = json.loads(line)
                found[row["key"]] = row["response"]
    return found


def main():
    crossings = json.loads((WEB_DATA / "crossings.geojson").read_text(encoding="utf-8"))
    wanted = {feature["properties"]["id"] for feature in crossings["features"]}
    with (DATA / "pairs.csv").open(encoding="utf-8", newline="") as handle:
        pairs = {row["pair_id"]: row for row in csv.DictReader(handle) if row["pair_id"] in wanted}

    cache = load_cache()
    features = []
    missing = []
    for pair_id in sorted(wanted):
        pair = pairs.get(pair_id)
        if not pair:
            missing.append(pair_id)
            continue
        origin = [round(float(pair["lon_a"]), 6), round(float(pair["lat_a"]), 6)]
        destination = [round(float(pair["lon_b"]), 6), round(float(pair["lat_b"]), 6)]
        response = cache.get(
            cache_key(
                {
                    "Origin": origin,
                    "Destination": destination,
                    "TravelMode": "Pedestrian",
                    "LegGeometryFormat": "Simple",
                }
            )
        )
        if not response:
            missing.append(pair_id)
            continue
        line = response["Routes"][0]["Legs"][0].get("Geometry", {}).get("LineString") or []
        if len(line) < 2:
            missing.append(pair_id)
            continue
        coords = []
        for lon, lat in line:
            point = [round(lon, 5), round(lat, 5)]
            if not coords or coords[-1] != point:
                coords.append(point)
        features.append(
            {
                "type": "Feature",
                "properties": {"id": pair_id, "a": origin, "b": destination},
                "geometry": {"type": "LineString", "coordinates": coords},
            }
        )

    out = WEB_DATA / "routes.geojson"
    out.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"wrote {len(features)} routes to {out} ({out.stat().st_size // 1024} KB)")
    if missing:
        print(f"no cached route for {len(missing)}: {', '.join(missing[:10])}")


if __name__ == "__main__":
    main()
