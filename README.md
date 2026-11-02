# Safe Crossing

A map of Bengaluru bus stops where the stop across the road is a long walk. Built for the AWS Weekend Challenge, [Map it](https://builder.aws.com/build/hackathons/e7a301ea-4d84-3b9e-95be-7340a70f7781/weekend-challenge-map-it).

Live site: https://d3sb0ns6j3z1es.cloudfront.net/ — the map dashboard is at [/map.html](https://d3sb0ns6j3z1es.cloudfront.net/map.html).

The first place on the list is Byatarayanapura Flyover. The two stops are 25 metres apart, one towards Venkatala and one towards Hebbal, and 1,033 buses are scheduled to arrive there in a day. The pedestrian route between them is 5.4 kilometres. That junction is also the traffic police's highest-listed blackspot on Ballari Road, with 11 fatalities from 2021 to 2023.

## What people can explore

- **Fix these first.** 285 stop pairs where the walked route is at least three times the straight-line distance and more than 150 metres longer. Ranked by extra walking minutes times scheduled arrivals. Filter by how many buses use the stop, or show only pairs within 500 metres of a police-named high-risk location.
- **A card for each crossing.** Opening a stop draws the walk Amazon Location returned, from stop A to stop B, with the outbound and return legs offset so the detour reads on the map. The card has the straight-line gap, walked distance, extra minutes, the two stop descriptions, and a link that reopens that crossing. Search by stop or junction name.
- **Stay off the corridor.** Five precomputed walks. Each one draws the direct pedestrian route and a second route that avoids a named high-risk corridor. At Bommanahalli, on the Silk Board to Veerasandra stretch of Hosur Road, the direct walk is 92 metres and the route that stays off Hosur Road is 852 metres.

## The dataset

Bus stops and schedules are the September 2026 BMTC GTFS feed published by [Vonter](https://github.com/Vonter/bmtc-gtfs) (ODbL, service dates through September 2027). It has 9,960 stops. The feed has one service that runs every day, so the count on the map is scheduled arrivals per day, not boardings.

Opposite sides are pairs of stops 12 to 70 metres apart that do not share a parent station. That produced 2,587 pairs. Scoring used the 962 pairs with at least 400 scheduled arrivals a day.

Named junctions and corridors come from chapters 14 and 15 of the Bengaluru Traffic Police Road Safety Report 2023, public domain via [OpenCity](https://data.opencity.in/dataset/bengaluru-traffic-police-road-safety-reports). In 2023 the police recorded 282 pedestrian deaths, 31 percent of all road deaths in the city. Fatality counts are shown only where the table reading is unambiguous. Corridor endpoints that geocoded far from the length printed in the report were dropped, so the lines on the map are the ones that matched.

The report does not publish crash coordinates. A dot is a bus stop or a geocoded place name, not a crash.

## How it got onto the map

Amazon Location Service, in `us-east-1`:

- **Routes, pedestrian.** For each busy pair, `CalculateRoutes` walks from one stop to the other. A gate check at Veerasandra on Hosur Road came back at 49 metres for a 41 metre gap, so that particular pair is crossable. Eight other busy pairs had a median walked distance 14 times the straight line. Garvebhavipalya was 49 metres apart and 894 metres on foot. The walking network is the crossing detector.
- **Routes, car, and avoid-corridors.** Each kept corridor is a shortest car route between the report's endpoints. The comparison walk asks for the same pedestrian trip with that line as an avoid corridor.
- **Places.** Junction and corridor names are geocoded. When the geocoder returned a different place, and a BMTC stop cluster of that name was far away, the stop cluster was used instead. Summanahalli is the case that needed it.
- **Maps.** The page is MapLibre with the Amazon Location Standard style.

The join lives in an Athena Iceberg table, `safe_crossing.crossings`, on S3. Pairs and blackspots are staged as JSON, then this query attaches the nearest named place within 500 metres and stores the result as Iceberg:

```sql
-- see sql/create_crossings.sql
CREATE TABLE safe_crossing.crossings
WITH (table_type = 'ICEBERG', format = 'PARQUET', is_external = false)
AS
SELECT ... FROM pairs CROSS JOIN blackspots ...
```

The map does not query Athena when someone clicks. `sql/export_crossings.sql` is what produced `web/data/crossings.geojson`. CloudFront serves that file. A judge session cannot fail on a live route call.

21 of the 285 gaps sit within 500 metres of a named high-risk location. The pattern is reusable. Another city needs a GTFS feed and a list of named places. `pipeline/ingest_gtfs.py`, `pipeline/score_routes.py`, and `pipeline/places.py` are the three steps. Route responses are cached in `data/route_cache.jsonl` so a rerun does not repeat paid calls.

## Run it again

Python 3.12 and the AWS CLI, authenticated in `us-east-1`. No third-party packages.

```text
python pipeline/ingest_gtfs.py
python pipeline/score_routes.py
python pipeline/places.py
python pipeline/load_iceberg.py
python pipeline/export_routes.py
python pipeline/deploy.py
```

`export_routes.py` reads the walked route for each gap out of `data/route_cache.jsonl` into `web/data/routes.geojson`. It makes no new Amazon Location calls.

`deploy.py infra` creates the bucket and CloudFront distribution. `deploy.py` publishes the site and writes a referrer-locked Amazon Location API key into `web/config.js`, which is not committed.

Derived stop data is ODbL. See [data/LICENSE](data/LICENSE).

## Demo shot list

Keep it under three minutes.

1. Open the map on the fix-first list. Read Byatarayanapura: 25 metres apart, a 5.4 kilometre walk, 1,033 buses, and the police blackspot.
2. Turn on "Near a blackspot" and open Singasandra.
3. Open Corridor walks, pick Bommanahalli, and show the 92 metre walk against the 852 metre walk that stays off Hosur Road.
4. Copy the link and reload it.
