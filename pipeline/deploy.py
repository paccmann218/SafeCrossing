"""Create the S3 and CloudFront front, then publish the map with a locked-down API key."""

import json
import shutil
import subprocess
from pathlib import Path

from lib import DATA, ROOT, write_json

BUCKET = "safe-crossing-889081505556"
REGION = "us-east-1"
ACCOUNT = "889081505556"
STATE = DATA / "deploy.json"
WEB = ROOT / "web"
CACHE_OPTIMIZED = "658327ea-f89d-4fab-a63d-7e88639e58f6"


def aws(*args, payload=None, check=True):
    exe = shutil.which("aws")
    command = [exe, *args, "--output", "json"]
    if payload is not None:
        path = DATA / "tmp-deploy.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        command.extend(["--cli-input-json", f"file://{path}"])
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    detail = "\n".join(
        line
        for line in (result.stderr or "").splitlines()
        if line.strip() and "File association not found" not in line
    )
    if result.returncode != 0 and check:
        raise RuntimeError(detail or result.stdout)
    try:
        parsed = json.loads(result.stdout) if result.stdout.strip() else {}
    except json.JSONDecodeError:
        parsed = {"raw": result.stdout}
    return result.returncode, parsed, detail


def load_state():
    if STATE.exists():
        return json.loads(STATE.read_text(encoding="utf-8"))
    return {}


def save_state(state):
    write_json(STATE, state)


def ensure_bucket():
    code, _, _ = aws("s3api", "head-bucket", "--bucket", BUCKET, "--region", REGION, check=False)
    if code != 0:
        aws("s3api", "create-bucket", "--bucket", BUCKET, "--region", REGION)
    aws(
        "s3api",
        "put-public-access-block",
        "--bucket",
        BUCKET,
        "--region",
        REGION,
        "--public-access-block-configuration",
        "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true",
    )


def ensure_oac(state):
    if state.get("oac_id"):
        return state["oac_id"]
    _, parsed, _ = aws(
        "cloudfront",
        "create-origin-access-control",
        "--origin-access-control-config",
        json.dumps(
            {
                "Name": "safe-crossing-oac",
                "Description": "Safe Crossing S3 origin",
                "SigningProtocol": "sigv4",
                "SigningBehavior": "always",
                "OriginAccessControlOriginType": "s3",
            }
        ),
    )
    state["oac_id"] = parsed["OriginAccessControl"]["Id"]
    save_state(state)
    return state["oac_id"]


def ensure_distribution(state):
    if state.get("distribution_id"):
        return
    config = {
        "CallerReference": "safe-crossing-889081505556",
        "Comment": "Safe Crossing Bengaluru",
        "Enabled": True,
        "DefaultRootObject": "index.html",
        "PriceClass": "PriceClass_All",
        "HttpVersion": "http2",
        "Origins": {
            "Quantity": 1,
            "Items": [
                {
                    "Id": "s3",
                    "DomainName": f"{BUCKET}.s3.{REGION}.amazonaws.com",
                    "OriginAccessControlId": state["oac_id"],
                    "S3OriginConfig": {"OriginAccessIdentity": ""},
                }
            ],
        },
        "DefaultCacheBehavior": {
            "TargetOriginId": "s3",
            "ViewerProtocolPolicy": "redirect-to-https",
            "Compress": True,
            "CachePolicyId": CACHE_OPTIMIZED,
            "AllowedMethods": {
                "Quantity": 2,
                "Items": ["GET", "HEAD"],
                "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]},
            },
        },
        "ViewerCertificate": {"CloudFrontDefaultCertificate": True},
    }
    _, parsed, _ = aws("cloudfront", "create-distribution", "--distribution-config", json.dumps(config))
    distribution = parsed["Distribution"]
    state["distribution_id"] = distribution["Id"]
    state["domain"] = distribution["DomainName"]
    save_state(state)


def bucket_policy(state):
    policy = {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Sid": "AllowCloudFront",
                "Effect": "Allow",
                "Principal": {"Service": "cloudfront.amazonaws.com"},
                "Action": "s3:GetObject",
                "Resource": f"arn:aws:s3:::{BUCKET}/*",
                "Condition": {
                    "StringEquals": {
                        "AWS:SourceArn": f"arn:aws:cloudfront::{ACCOUNT}:distribution/{state['distribution_id']}"
                    }
                },
            }
        ],
    }
    aws(
        "s3api",
        "put-bucket-policy",
        "--bucket",
        BUCKET,
        "--region",
        REGION,
        "--policy",
        json.dumps(policy),
    )


def ensure_key(state):
    if state.get("api_key"):
        return
    restrictions = {
        "AllowActions": [
            "geo-maps:*",
            "geo-places:Geocode",
            "geo-places:ReverseGeocode",
            "geo-places:Suggest",
            "geo-places:GetPlace",
            "geo-routes:CalculateRoutes",
        ],
        "AllowResources": [
            f"arn:aws:geo-maps:{REGION}::provider/default",
            f"arn:aws:geo-places:{REGION}::provider/default",
            f"arn:aws:geo-routes:{REGION}::provider/default",
        ],
        "AllowReferers": [f"https://{state['domain']}/*"],
    }
    _, parsed, _ = aws(
        "location",
        "create-key",
        "--region",
        REGION,
        "--key-name",
        "safe-crossing",
        "--no-expiry",
        "--description",
        "Safe Crossing public map",
        "--restrictions",
        json.dumps(restrictions),
    )
    state["api_key"] = parsed.get("Key") or parsed.get("KeyArn")
    if not state["api_key"] or state["api_key"].startswith("arn:"):
        raise RuntimeError(f"CreateKey did not return a key string: {list(parsed)}")
    save_state(state)


def write_config(state):
    (WEB / "config.js").write_text(
        "window.SAFE_CROSSING = "
        + json.dumps({"region": REGION, "apiKey": state["api_key"]}, indent=2)
        + ";\n",
        encoding="utf-8",
    )


def upload():
    aws(
        "s3",
        "sync",
        str(WEB),
        f"s3://{BUCKET}/",
        "--region",
        REGION,
        "--delete",
        "--exclude",
        "config.example.js",
        # The same bucket holds the Athena staging data and the Iceberg table.
        # Excluded paths are never deleted by sync, so the site deploy leaves them alone.
        "--exclude",
        "staging/*",
        "--exclude",
        "iceberg/*",
        "--exclude",
        "athena-results/*",
        "--cache-control",
        "public,max-age=300",
    )
    for name in ("index.html", "map.html", "app.js", "home.js", "styles.css", "config.js"):
        aws(
            "s3",
            "cp",
            str(WEB / name),
            f"s3://{BUCKET}/{name}",
            "--region",
            REGION,
            "--cache-control",
            "public,max-age=60",
            "--content-type",
            {
                "index.html": "text/html; charset=utf-8",
                "map.html": "text/html; charset=utf-8",
                "app.js": "text/javascript; charset=utf-8",
                "home.js": "text/javascript; charset=utf-8",
                "styles.css": "text/css; charset=utf-8",
                "config.js": "text/javascript; charset=utf-8",
            }[name],
        )


def invalidate(state):
    aws(
        "cloudfront",
        "create-invalidation",
        "--distribution-id",
        state["distribution_id"],
        "--paths",
        "/*",
    )


def infra():
    state = load_state()
    ensure_bucket()
    ensure_oac(state)
    ensure_distribution(state)
    bucket_policy(state)
    print(f"https://{state['domain']}/")


def publish():
    state = load_state()
    if not state.get("domain"):
        infra()
        state = load_state()
    ensure_key(state)
    write_config(state)
    upload()
    invalidate(state)
    print(f"https://{state['domain']}/")


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "infra":
        infra()
    else:
        publish()
