"""Geocode police places, draw corridors, and precompute walks that stay off them."""

import csv
import io
import zipfile
from collections import defaultdict

from aws_geo import geocode, route
from lib import (
    DATA,
    RAW,
    WEB_DATA,
    haversine_m,
    in_bengaluru,
    point_line_m,
    read_json,
    simplify,
    write_json,
)

SEED = DATA / "places_seed.json"


def stop_clusters():
    path = RAW / "bmtc.zip"
    if not path.exists():
        return []
    with zipfile.ZipFile(path) as archive:
        rows = list(csv.DictReader(io.TextIOWrapper(archive.open("stops.txt"), encoding="utf-8")))
    grouped = defaultdict(list)
    for row in rows:
        grouped[row["stop_name"].strip().casefold()].append((float(row["stop_lon"]), float(row["stop_lat"])))
    return grouped


STOPS = None


def snap_blackspot(name):
    global STOPS
    if STOPS is None:
        STOPS = stop_clusters()
    token = name.casefold().split(" junction")[0].split(" bus stop")[0].strip()
    points = STOPS.get(token) or []
    if len(points) < 2:
        return None
    lon = sum(point[0] for point in points) / len(points)
    lat = sum(point[1] for point in points) / len(points)
    return {"lon": lon, "lat": lat, "label": f"BMTC stops named {token}"}


def first_in_city(query):
    hits = geocode(query)
    for hit in hits:
        if in_bengaluru(hit["lon"], hit["lat"]):
            return hit
    return hits[0] if hits else None


def load_pairs():
    with (DATA / "pairs.csv").open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def geocode_blackspots(seed):
    features = []
    for spot in seed["blackspots"]:
        hit = first_in_city(spot["query"])
        if not hit or not in_bengaluru(hit["lon"], hit["lat"]):
            print(f"drop blackspot {spot['id']}: {hit}")
            continue
        snapped = snap_blackspot(spot["name"])
        token = spot["name"].casefold().split(" junction")[0].split(" bus stop")[0].strip()
        geocode_missed_the_name = token not in hit["label"].casefold()
        if (
            snapped
            and geocode_missed_the_name
            and haversine_m(hit["lon"], hit["lat"], snapped["lon"], snapped["lat"]) > 1500
        ):
            print(f"snap {spot['name']} off a bad geocode onto the BMTC stops")
            hit = snapped
        print(f"blackspot {spot['name']} -> {hit['label']} ({hit['lon']:.5f}, {hit['lat']:.5f})")
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [round(hit["lon"], 6), round(hit["lat"], 6)]},
                "properties": {
                    "id": spot["id"],
                    "name": spot["name"],
                    "road": spot["road"],
                    "division": spot["division"],
                    "fatalities": spot["fatalities"],
                    "geocode_label": hit["label"],
                },
            }
        )
    return {"type": "FeatureCollection", "features": features}


def accept_corridor(corridor, start, end, driven_m):
    stated = corridor["length_km"] * 1000
    straight = haversine_m(start["lon"], start["lat"], end["lon"], end["lat"])
    if straight < stated * 0.35 or straight > stated * 1.6:
        print(f"drop {corridor['id']}: straight {straight:.0f} m vs stated {stated:.0f} m")
        return False
    if driven_m < stated * 0.55 or driven_m > stated * 1.85:
        print(f"drop {corridor['id']}: driven {driven_m:.0f} m vs stated {stated:.0f} m")
        return False
    return True


def geocode_corridors(seed):
    features = []
    for corridor in seed["corridors"]:
        start = first_in_city(corridor["from_query"])
        end = first_in_city(corridor["to_query"])
        if not start or not end:
            print(f"drop {corridor['id']}: geocode failed")
            continue
        if not in_bengaluru(start["lon"], start["lat"]) or not in_bengaluru(end["lon"], end["lat"]):
            print(f"drop {corridor['id']}: outside Bengaluru")
            continue
        driven = route((start["lon"], start["lat"]), (end["lon"], end["lat"]), "Car")
        line = driven["line"]
        if len(line) < 2 or not driven["distance_m"]:
            print(f"drop {corridor['id']}: no car route")
            continue
        if not accept_corridor(corridor, start, end, driven["distance_m"]):
            continue
        name = f"{corridor['from']} to {corridor['to']}"
        print(f"corridor {name}: {driven['distance_m']} m on {corridor['road']}")
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": line},
                "properties": {
                    "id": corridor["id"],
                    "name": name,
                    "road": corridor["road"],
                    "division": corridor["division"],
                    "rank": corridor["rank"],
                    "from": corridor["from"],
                    "to": corridor["to"],
                    "length_km": corridor["length_km"],
                    "fatalities": corridor["fatalities"],
                    "route_m": driven["distance_m"],
                },
            }
        )
    return {"type": "FeatureCollection", "features": features}


def walk_for_corridor(corridor, pairs):
    line = simplify(corridor["geometry"]["coordinates"], 30)
    hits = []
    for pair in pairs:
        if pair["same_name"] != "true" or int(pair["arrivals"]) < 400:
            continue
        dist = point_line_m(float(pair["lon"]), float(pair["lat"]), line)
        if dist <= 70:
            hits.append((dist, -int(pair["arrivals"]), pair))
    hits.sort()
    best = None
    for _, _, pair in hits[:10]:
        origin = (float(pair["lon_a"]), float(pair["lat_a"]))
        destination = (float(pair["lon_b"]), float(pair["lat_b"]))
        try:
            short = route(origin, destination, "Pedestrian")
        except RuntimeError as error:
            print(f"  route failed: {error}")
            continue
        if not short["distance_m"] or not short["line"] or short["distance_m"] > 250:
            continue
        for radius in (45, 90):
            try:
                avoid = route(origin, destination, "Pedestrian", avoid_line=line, avoid_radius=radius)
            except RuntimeError as error:
                print(f"  route failed: {error}")
                continue
            if not avoid["distance_m"] or not avoid["line"]:
                continue
            extra = avoid["duration_s"] - short["duration_s"]
            print(
                f"  walk {pair['name']} r{radius}: short {short['distance_m']} m, "
                f"avoid {avoid['distance_m']} m, extra {extra} s"
            )
            plausible = (
                120 <= extra <= 1500
                and avoid["distance_m"] >= short["distance_m"] * 1.7
                and avoid["distance_m"] <= 2000
            )
            if plausible and (best is None or extra > best[0]):
                best = (extra, pair, short, avoid, line)
            if plausible:
                break
    if not best:
        return None
    return best[1], best[2], best[3], best[4]


def build_walks(corridors, pairs):
    ranked = sorted(
        corridors["features"],
        key=lambda feature: feature["properties"]["fatalities"] or 0,
        reverse=True,
    )
    features = []
    used_names = set()
    for corridor in ranked:
        if len({feature["properties"]["walk_id"] for feature in features}) >= 6:
            break
        print(f"trying walks on {corridor['properties']['name']}")
        found = walk_for_corridor(corridor, pairs)
        if not found:
            print("  no contrasting walk")
            continue
        pair, short, avoid, _line = found
        if pair["name"] in used_names:
            continue
        used_names.add(pair["name"])
        props = corridor["properties"]
        base = {
            "walk_id": props["id"],
            "title": f"Across {props['road']} at {pair['name']}",
            "stop_name": pair["name"],
            "desc_a": pair["desc_a"],
            "desc_b": pair["desc_b"],
            "arrivals": int(pair["arrivals"]),
            "corridor": props["name"],
            "road": props["road"],
            "fatalities": props["fatalities"],
            "origin": [float(pair["lon_a"]), float(pair["lat_a"])],
            "destination": [float(pair["lon_b"]), float(pair["lat_b"])],
        }
        for variant, result in (("shortest", short), ("avoid", avoid)):
            features.append(
                {
                    "type": "Feature",
                    "geometry": {"type": "LineString", "coordinates": result["line"]},
                    "properties": {
                        **base,
                        "variant": variant,
                        "distance_m": result["distance_m"],
                        "duration_s": result["duration_s"],
                        "notices": len(result["notices"]),
                    },
                }
            )
    return {"type": "FeatureCollection", "features": features}


def main():
    seed = read_json(SEED)
    pairs = load_pairs()
    blackspots = geocode_blackspots(seed)
    corridors = geocode_corridors(seed)
    walks = build_walks(corridors, pairs)
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    write_json(WEB_DATA / "blackspots.geojson", blackspots)
    write_json(WEB_DATA / "corridors.geojson", corridors)
    write_json(WEB_DATA / "walks.geojson", walks)
    write_json(
        DATA / "places_summary.json",
        {
            "blackspots": len(blackspots["features"]),
            "corridors": len(corridors["features"]),
            "walks": len({feature["properties"]["walk_id"] for feature in walks["features"]}),
        },
    )
    print(read_json(DATA / "places_summary.json"))


if __name__ == "__main__":
    main()
