"""Shared geometry and file helpers for the Safe Crossing pipeline."""

import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
RAW = DATA / "raw"
WEB_DATA = ROOT / "web" / "data"
REGION = "us-east-1"

WALK_METRES_PER_MIN = 80
PAIR_MIN_M = 12
PAIR_MAX_M = 70
GAP_MIN_M = 150
BLACKSPOT_RADIUS_M = 350
ARRIVALS_MIN = 400

BBOX = (12.70, 77.30, 13.45, 77.95)


def haversine_m(lon1, lat1, lon2, lat2):
    radius = 6_371_000.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    h = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlmb / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(h))


def midpoint(lon1, lat1, lon2, lat2):
    return (lon1 + lon2) / 2, (lat1 + lat2) / 2


def in_bengaluru(lon, lat):
    south, west, north, east = BBOX
    return south <= lat <= north and west <= lon <= east


def local_metres(lon, lat, origin_lon, origin_lat):
    lat_scale = 111_320.0
    lon_scale = 111_320.0 * math.cos(math.radians(origin_lat))
    return (lon - origin_lon) * lon_scale, (lat - origin_lat) * lat_scale


def point_segment_m(lon, lat, ax, ay, bx, by):
    px, py = local_metres(lon, lat, ax, ay)
    qx, qy = local_metres(bx, by, ax, ay)
    seg_len_sq = qx * qx + qy * qy
    if seg_len_sq == 0:
        return math.hypot(px, py)
    t = max(0.0, min(1.0, (px * qx + py * qy) / seg_len_sq))
    return math.hypot(px - qx * t, py - qy * t)


def point_line_m(lon, lat, line):
    best = None
    for i in range(len(line) - 1):
        dist = point_segment_m(lon, lat, line[i][0], line[i][1], line[i + 1][0], line[i + 1][1])
        if best is None or dist < best:
            best = dist
    return best if best is not None else 1e12


def simplify(line, max_points):
    if len(line) <= max_points:
        return line
    if max_points < 2:
        return [line[0], line[-1]]
    step = (len(line) - 1) / (max_points - 1)
    chosen = [line[int(round(i * step))] for i in range(max_points)]
    chosen[-1] = line[-1]
    return chosen


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
