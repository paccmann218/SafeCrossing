"""Download mapped crossings and footbridges for Bengaluru from OpenStreetMap.

Tiles are small and saved as they finish, so a timeout can be resumed.
"""

import json
import time
import urllib.parse
import urllib.request

from lib import BBOX, DATA, write_json

ENDPOINTS = (
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.openstreetmap.fr/api/interpreter",
)
QUERY = """
[out:json][timeout:90];
(
  node["highway"="crossing"]({s},{w},{n},{e});
  node["crossing"]({s},{w},{n},{e});
  way["footway"="crossing"]({s},{w},{n},{e});
  way["bridge"="yes"]["highway"~"^(footway|steps|path)$"]({s},{w},{n},{e});
);
out center;
""".strip()
TILES = DATA / "osm_tiles"
STEP = 0.12


def tiles():
    south, west, north, east = BBOX
    lat = south
    while lat < north:
        lon = west
        while lon < east:
            yield (round(lat, 4), round(lon, 4), round(min(lat + STEP, north), 4), round(min(lon + STEP, east), 4))
            lon += STEP
        lat += STEP


def fetch(query):
    body = urllib.parse.urlencode({"data": query}).encode()
    last_error = None
    for endpoint in ENDPOINTS:
        request = urllib.request.Request(
            endpoint,
            data=body,
            headers={"User-Agent": "safe-crossing-map/1.0 (bengaluru pedestrian crossings)"},
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return json.load(response)
        except Exception as error:
            last_error = error
            print(f"  {endpoint} failed: {error}", flush=True)
            time.sleep(3)
    raise RuntimeError(last_error)


def tile_path(bounds):
    south, west, north, east = bounds
    return TILES / f"{south}_{west}_{north}_{east}.json"


def main():
    TILES.mkdir(parents=True, exist_ok=True)
    pending = [bounds for bounds in tiles() if not tile_path(bounds).exists()]
    print(f"{len(pending)} tiles to fetch", flush=True)
    for index, bounds in enumerate(pending, start=1):
        south, west, north, east = bounds
        print(f"[{index}/{len(pending)}] {south},{west} {north},{east}", flush=True)
        try:
            payload = fetch(QUERY.format(s=south, w=west, n=north, e=east))
        except Exception as error:
            print(f"  giving up on tile: {error}", flush=True)
            continue
        points = []
        for element in payload.get("elements", []):
            if element["type"] == "node":
                lon, lat, kind = element["lon"], element["lat"], "crossing"
            else:
                center = element.get("center")
                if not center:
                    continue
                tags = element.get("tags") or {}
                lon, lat = center["lon"], center["lat"]
                kind = "footbridge" if tags.get("bridge") == "yes" else "crossing"
            points.append({"lon": lon, "lat": lat, "kind": kind})
        tile_path(bounds).write_text(json.dumps(points), encoding="utf-8")
        print(f"  {len(points)} points", flush=True)
        time.sleep(1)

    seen = set()
    merged = []
    for path in TILES.glob("*.json"):
        for point in json.loads(path.read_text(encoding="utf-8")):
            key = (round(point["lon"], 5), round(point["lat"], 5))
            if key in seen:
                continue
            seen.add(key)
            merged.append(point)
    write_json(DATA / "osm_crossings.json", {"count": len(merged), "points": merged})
    print(f"wrote {len(merged)} crossings", flush=True)


if __name__ == "__main__":
    main()
