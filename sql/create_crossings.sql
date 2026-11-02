-- Safe Crossing pairs scored by Amazon Location pedestrian routing.
-- Bucket and database names are substituted by pipeline/load_iceberg.py.

CREATE DATABASE IF NOT EXISTS safe_crossing;

DROP TABLE IF EXISTS safe_crossing.pairs_json;

CREATE EXTERNAL TABLE safe_crossing.pairs_json (
  pair_id string,
  name string,
  same_name boolean,
  lon double,
  lat double,
  straight_m double,
  walk_m double,
  extra_m double,
  duration_s double,
  extra_min double,
  arrivals int,
  impact double,
  is_gap boolean,
  name_a string,
  name_b string,
  desc_a string,
  desc_b string
)
ROW FORMAT SERDE 'org.openx.data.jsonserde.JsonSerDe'
LOCATION 's3://__BUCKET__/staging/pairs/';

DROP TABLE IF EXISTS safe_crossing.blackspots_json;

CREATE EXTERNAL TABLE safe_crossing.blackspots_json (
  id string,
  name string,
  road string,
  division string,
  fatalities int,
  lon double,
  lat double
)
ROW FORMAT SERDE 'org.openx.data.jsonserde.JsonSerDe'
LOCATION 's3://__BUCKET__/staging/blackspots/';

DROP TABLE IF EXISTS safe_crossing.crossings;

CREATE TABLE safe_crossing.crossings
WITH (
  table_type = 'ICEBERG',
  format = 'PARQUET',
  is_external = false,
  location = 's3://__BUCKET__/iceberg/crossings/'
) AS
WITH distances AS (
  SELECT
    p.pair_id,
    p.name,
    p.same_name,
    p.lon,
    p.lat,
    p.straight_m,
    p.walk_m,
    p.extra_m,
    p.duration_s,
    p.extra_min,
    p.arrivals,
    p.impact,
    p.is_gap,
    p.name_a,
    p.name_b,
    p.desc_a,
    p.desc_b,
    b.name AS blackspot_name,
    b.road AS blackspot_road,
    b.division AS blackspot_division,
    b.fatalities AS blackspot_fatalities,
    2 * 6371000 * asin(least(1.0, sqrt(
      pow(sin(radians(b.lat - p.lat) / 2), 2)
      + cos(radians(p.lat)) * cos(radians(b.lat)) * pow(sin(radians(b.lon - p.lon) / 2), 2)
    ))) AS blackspot_m
  FROM safe_crossing.pairs_json p
  CROSS JOIN safe_crossing.blackspots_json b
),
ranked AS (
  SELECT
    *,
    row_number() OVER (PARTITION BY pair_id ORDER BY blackspot_m) AS rn
  FROM distances
)
SELECT
  pair_id,
  name,
  same_name,
  lon,
  lat,
  straight_m,
  walk_m,
  extra_m,
  duration_s,
  extra_min,
  arrivals,
  impact,
  is_gap,
  name_a,
  name_b,
  desc_a,
  desc_b,
  CASE WHEN blackspot_m < 500 THEN blackspot_name ELSE NULL END AS blackspot,
  CASE WHEN blackspot_m < 500 THEN blackspot_road ELSE NULL END AS blackspot_road,
  CASE WHEN blackspot_m < 500 THEN blackspot_division ELSE NULL END AS division,
  CASE WHEN blackspot_m < 500 THEN blackspot_fatalities ELSE NULL END AS blackspot_fatalities,
  CASE WHEN blackspot_m < 500 THEN blackspot_m ELSE NULL END AS blackspot_m
FROM ranked
WHERE rn = 1;
