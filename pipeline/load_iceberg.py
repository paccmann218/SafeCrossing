"""Load the scored pairs and blackspots into an Athena Iceberg table, then export the map."""

import csv
import json
import shutil
import subprocess
import time
from pathlib import Path

from lib import DATA, ROOT, WEB_DATA, write_json

BUCKET = "safe-crossing-889081505556"
REGION = "us-east-1"
DATABASE = "safe_crossing"
WORKGROUP = "safe-crossing"


def aws(*args, check=True):
    exe = shutil.which("aws")
    result = subprocess.run(
        [exe, *args, "--region", REGION, "--output", "json"],
        capture_output=True,
        text=True,
        check=False,
    )
    detail = "\n".join(
        line
        for line in (result.stderr or "").splitlines()
        if line.strip() and "File association not found" not in line
    )
    if result.returncode != 0 and check:
        raise RuntimeError(detail or result.stdout)
    return result.returncode, result.stdout, detail


def ensure_bucket():
    code, _, detail = aws("s3api", "head-bucket", "--bucket", BUCKET, check=False)
    if code == 0:
        print("bucket exists")
        return
    print("creating bucket")
    aws("s3api", "create-bucket", "--bucket", BUCKET)
    aws(
        "s3api",
        "put-public-access-block",
        "--bucket",
        BUCKET,
        "--public-access-block-configuration",
        "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true",
    )


def ensure_workgroup():
    code, _, _ = aws("athena", "get-work-group", "--work-group", WORKGROUP, check=False)
    if code == 0:
        return
    payload = {
        "Name": WORKGROUP,
        "Configuration": {
            "ResultConfiguration": {"OutputLocation": f"s3://{BUCKET}/athena-results/"},
            "EnforceWorkGroupConfiguration": True,
            "PublishCloudWatchMetricsEnabled": False,
        },
        "Description": "Safe Crossing map queries",
    }
    path = DATA / "tmp-workgroup.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    aws("athena", "create-work-group", "--cli-input-json", f"file://{path}")


def statements():
    text = (ROOT / "sql" / "create_crossings.sql").read_text(encoding="utf-8")
    text = text.replace("__BUCKET__", BUCKET)
    chunks = []
    for chunk in text.split(";"):
        lines = [line for line in chunk.splitlines() if line.strip() and not line.strip().startswith("--")]
        sql = "\n".join(lines).strip()
        if sql:
            chunks.append(sql)
    return chunks


def run_query(sql, database=DATABASE):
    payload = {
        "QueryString": sql,
        "QueryExecutionContext": {"Database": database},
        "WorkGroup": WORKGROUP,
    }
    path = DATA / "tmp-athena.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    _, stdout, _ = aws("athena", "start-query-execution", "--cli-input-json", f"file://{path}")
    query_id = json.loads(stdout)["QueryExecutionId"]
    print(f"query {query_id}: {sql.splitlines()[0][:80]}")
    for _ in range(90):
        _, body, _ = aws("athena", "get-query-execution", "--query-execution-id", query_id)
        status = json.loads(body)["QueryExecution"]["Status"]
        state = status["State"]
        if state == "SUCCEEDED":
            return query_id
        if state in ("FAILED", "CANCELLED"):
            raise RuntimeError(status.get("StateChangeReason") or state)
        time.sleep(2)
    raise RuntimeError(f"query timed out: {query_id}")


def write_staging():
    pairs_dir = DATA / "staging" / "pairs"
    spots_dir = DATA / "staging" / "blackspots"
    pairs_dir.mkdir(parents=True, exist_ok=True)
    spots_dir.mkdir(parents=True, exist_ok=True)
    count = 0
    with (pairs_dir / "pairs.jsonl").open("w", encoding="utf-8") as handle:
        for line in (DATA / "scored_pairs.jsonl").read_text(encoding="utf-8").splitlines():
            if line.strip():
                handle.write(line + "\n")
                count += 1
    spots = json.loads((WEB_DATA / "blackspots.geojson").read_text(encoding="utf-8"))
    with (spots_dir / "blackspots.jsonl").open("w", encoding="utf-8") as handle:
        for feature in spots["features"]:
            props = feature["properties"]
            lon, lat = feature["geometry"]["coordinates"]
            handle.write(
                json.dumps(
                    {
                        "id": props["id"],
                        "name": props["name"],
                        "road": props["road"],
                        "division": props["division"],
                        "fatalities": props["fatalities"],
                        "lon": lon,
                        "lat": lat,
                    }
                )
                + "\n"
            )
    aws("s3", "rm", f"s3://{BUCKET}/staging/pairs/", "--recursive", check=False)
    aws("s3", "rm", f"s3://{BUCKET}/staging/blackspots/", "--recursive", check=False)
    aws("s3", "cp", str(pairs_dir / "pairs.jsonl"), f"s3://{BUCKET}/staging/pairs/pairs.jsonl")
    aws("s3", "cp", str(spots_dir / "blackspots.jsonl"), f"s3://{BUCKET}/staging/blackspots/blackspots.jsonl")
    aws("s3", "rm", f"s3://{BUCKET}/iceberg/crossings/", "--recursive", check=False)
    print(f"staged {count} pairs and {len(spots['features'])} blackspots")


def export_geojson(query_id):
    destination = DATA / "athena_crossings.csv"
    aws("s3", "cp", f"s3://{BUCKET}/athena-results/{query_id}.csv", str(destination))
    features = []
    with destination.open(encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            if (row.get("is_gap") or "true").lower() not in ("true", "1"):
                # The export query already filters to gaps. Keep a guard for a raw dump.
                if "is_gap" in row:
                    continue
            features.append(
                {
                    "type": "Feature",
                    "geometry": {
                        "type": "Point",
                        "coordinates": [float(row["lon"]), float(row["lat"])],
                    },
                    "properties": {
                        "id": row["pair_id"],
                        "name": row["name"],
                        "sameName": (row.get("same_name") or "").lower() == "true",
                        "straightM": float(row["straight_m"]),
                        "walkM": float(row["walk_m"]),
                        "extraM": float(row["extra_m"]),
                        "extraMin": float(row["extra_min"]),
                        "arrivals": int(float(row["arrivals"])),
                        "impact": float(row["impact"]),
                        "descA": row.get("desc_a") or "",
                        "descB": row.get("desc_b") or "",
                        "blackspot": row.get("blackspot") or "",
                        "blackspotRoad": row.get("blackspot_road") or "",
                        "division": row.get("division") or "",
                        "blackspotFatalities": row.get("blackspot_fatalities") or "",
                    },
                }
            )
    features.sort(key=lambda feature: feature["properties"]["impact"], reverse=True)
    collection = {"type": "FeatureCollection", "features": features}
    write_json(WEB_DATA / "crossings.geojson", collection)
    top = features[0]["properties"] if features else {}
    named = sum(1 for feature in features if feature["properties"]["blackspot"])
    summary = {
        "gaps": len(features),
        "topName": top.get("name", ""),
        "topStraightM": top.get("straightM"),
        "topWalkM": top.get("walkM"),
        "topArrivals": top.get("arrivals"),
        "topExtraMin": top.get("extraMin"),
        "namedGaps": named,
        "pedestrians2023": 282,
        "source": "athena-iceberg",
    }
    write_json(WEB_DATA / "summary.json", summary)
    write_json(DATA / "map_summary.json", summary)
    print(summary)


def main():
    ensure_bucket()
    ensure_workgroup()
    write_staging()
    for sql in statements():
        database = "default" if sql.upper().startswith("CREATE DATABASE") else DATABASE
        run_query(sql, database)
    export_sql = (ROOT / "sql" / "export_crossings.sql").read_text(encoding="utf-8")
    export_sql = "\n".join(
        line for line in export_sql.splitlines() if line.strip() and not line.strip().startswith("--")
    )
    query_id = run_query(export_sql)
    export_geojson(query_id)


if __name__ == "__main__":
    main()
