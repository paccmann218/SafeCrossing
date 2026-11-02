"""Amazon Location calls, with a JSONL cache so reruns do not repeat them."""

import hashlib
import json
import shutil
import subprocess
import threading
import time
from pathlib import Path

from lib import DATA, REGION

CACHE = DATA / "route_cache.jsonl"


def _load_cache():
    found = {}
    if not CACHE.exists():
        return found
    with CACHE.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            found[row["key"]] = row["response"]
    return found


_CACHE = None
_LOCK = threading.Lock()


def _cache():
    global _CACHE
    if _CACHE is None:
        _CACHE = _load_cache()
    return _CACHE


def _remember(key, response):
    _cache()[key] = response
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    with CACHE.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"key": key, "response": response}, ensure_ascii=False) + "\n")


def _aws(service, command, payload):
    key = hashlib.sha256(
        json.dumps({"service": service, "command": command, "payload": payload}, sort_keys=True).encode()
    ).hexdigest()
    with _LOCK:
        cached = _cache().get(key)
    if cached is not None:
        return cached
    aws = shutil.which("aws")
    if not aws:
        raise RuntimeError("AWS CLI was not found on PATH")
    tmp = DATA / f"aws-input-{key[:16]}.json"
    tmp.write_text(json.dumps(payload), encoding="utf-8")
    tmp_uri = "file://" + tmp.resolve().as_posix()
    detail = ""
    result = None
    for attempt in range(5):
        result = subprocess.run(
            [
                aws,
                service,
                command,
                "--region",
                REGION,
                "--cli-input-json",
                tmp_uri,
                "--output",
                "json",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        detail = "\n".join(
            line
            for line in (result.stderr or "").splitlines()
            if line.strip() and "File association not found" not in line
        )
        if result.returncode == 0:
            break
        if "Throttl" in detail or "Too Many" in detail or "RequestLimit" in detail:
            time.sleep(2 ** attempt)
            continue
        raise RuntimeError(detail or result.stdout.strip())
    else:
        raise RuntimeError(detail or "Amazon Location kept throttling")
    try:
        tmp.unlink()
    except OSError:
        pass
    response = json.loads(result.stdout)
    with _LOCK:
        if key not in _cache():
            _remember(key, response)
    return response


def geocode(query):
    response = _aws(
        "geo-places",
        "geocode",
        {
            "QueryText": query,
            "MaxResults": 3,
            "BiasPosition": [77.59, 12.97],
        },
    )
    results = response.get("ResultItems") or response.get("Results") or []
    parsed = []
    for item in results:
        position = item.get("Position")
        if position is None and "Place" in item:
            position = item["Place"].get("Position")
        if not position:
            continue
        parsed.append(
            {
                "lon": position[0],
                "lat": position[1],
                "label": item.get("Title") or item.get("Address", {}).get("Label") or query,
            }
        )
    return parsed


def route(origin, destination, travel_mode, avoid_line=None, avoid_radius=45, optimize=None):
    payload = {
        "Origin": [round(origin[0], 6), round(origin[1], 6)],
        "Destination": [round(destination[0], 6), round(destination[1], 6)],
        "TravelMode": travel_mode,
        "LegGeometryFormat": "Simple",
    }
    if travel_mode == "Car":
        payload["OptimizeRoutingFor"] = optimize or "ShortestRoute"
    if avoid_line:
        payload["Avoid"] = {
            "Areas": [
                {
                    "Geometry": {
                        "Corridor": {
                            "LineString": [[round(lon, 5), round(lat, 5)] for lon, lat in avoid_line],
                            "Radius": avoid_radius,
                        }
                    }
                }
            ]
        }
    response = _aws("geo-routes", "calculate-routes", payload)
    route_row = response["Routes"][0]
    leg = route_row["Legs"][0]
    details = leg.get("PedestrianLegDetails") or leg.get("VehicleLegDetails") or {}
    summary = (details.get("Summary") or {}).get("Overview") or {}
    line = leg.get("Geometry", {}).get("LineString") or []
    notices = list(response.get("Notices") or []) + list(leg.get("Notices") or []) + list(details.get("Notices") or [])
    return {
        "distance_m": summary.get("Distance"),
        "duration_s": summary.get("Duration"),
        "line": line,
        "notices": notices,
        "road": (route_row.get("MajorRoadLabels") or [{}])[0].get("RoadName", {}).get("Value")
        or (route_row.get("MajorRoadLabels") or [{}])[0].get("RouteNumber", {}).get("Value"),
    }
