# Safe Crossing: the Bengaluru bus stops where the stop across the road is a 5 km walk

**Live map:** https://d3sb0ns6j3z1es.cloudfront.net/map.html
**Story page:** https://d3sb0ns6j3z1es.cloudfront.net/
**Demo video:** https://youtu.be/XKfD63EnCOY
**Code:** REPLACE_WITH_REPO_URL

**Built with:** Amazon Location Service (Routes, Places, Maps) · Amazon S3 · Amazon Athena · Apache Iceberg on S3 (AWS Glue Data Catalog) · Amazon CloudFront

![Safe Crossing landing page: the stop across the road can be a kilometre away](https://d3sb0ns6j3z1es.cloudfront.net/article/01-landing-hero.png)

---

## 25 metres, or 5.4 kilometres

There are two bus stops on Ballari Road at the Byatarayanapura flyover. One is for buses heading towards Hebbal, the other for buses heading towards Venkatala. They are **25 metres apart**. BMTC schedules **1,033 bus arrivals** there every day.

Say you get off on one side and your bus home leaves from the other. I asked Amazon Location for the walking route between the two stops. It came back at **5.4 kilometres**: 2.7 km up the road to the first place a pedestrian can get across, then 2.7 km back down the other side. That's about **67 extra minutes on foot** to cross a road you can see across.

That junction is also the Bengaluru Traffic Police's highest-listed blackspot on Ballari Road, with **11 deaths between 2021 and 2023**.

I don't think many people make that 5.4 km walk. I think they cross where they're standing. That's what this map is about.

[![Watch the demo](https://img.youtube.com/vi/XKfD63EnCOY/hqdefault.jpg)](https://youtu.be/XKfD63EnCOY)

---

## The problem

In 2023, **282 pedestrians were killed on Bengaluru's roads**. That's 31% of every road death in the city that year (Bengaluru Traffic Police, Road Safety Report 2023).

A bus trip is really two trips. Getting off the bus is the easy half. The trip back starts on the *other* side of the road, and on Bengaluru's arterial roads, the other side is often behind a median barrier, a flyover ramp or a service road wall. Those were built to keep cars moving. For someone on foot, they can turn a 25 metre crossing into a detour measured in kilometres.

I wanted a list of the places where that happens, ranked so you'd know which to fix first. But I couldn't find an open, citywide dataset of where a pedestrian can legally cross: signals, zebra crossings, footbridges, gaps in medians.

So I flipped the question. Instead of looking for crossings, I **measured how far you have to walk when there isn't one**.

---

## The data I started with

| Dataset | What's in it | Licence | How I used it |
|---|---|---|---|
| [BMTC GTFS feed, September 2026](https://github.com/Vonter/bmtc-gtfs) (published by Vonter) | 9,960 bus stops with coordinates, every route and scheduled trip. Service dates run through September 2027 | ODbL | Stop positions, stop names and directions, scheduled arrivals per stop per day |
| [Bengaluru Traffic Police Road Safety Report 2023](https://data.opencity.in/dataset/bengaluru-traffic-police-road-safety-reports), chapters 14 and 15 (via OpenCity) | Named accident-prone junctions ("blackspots") and high-risk road corridors, with fatality counts for 2021–2023 | Public domain | Geocoded into points and lines, then joined to the stop pairs |

Two things I want to be upfront about:

- **The police report has names, not coordinates.** Every red ring on the map is a geocoded junction name. It is not a crash location.
- **"Buses a day" means scheduled arrivals, not passengers.** The September feed publishes a single service that runs every day, so I count the trips that stop there.

---

## The idea: let the walking network find the missing crossings

![How it works: the walking network is the crossing detector](https://d3sb0ns6j3z1es.cloudfront.net/article/04-landing-detector.png)

### Step 1: pair up stops that face each other

BMTC usually puts a stop on each side of the road with the same name and a "(Towards X)" suffix. I treated any two stops **12 to 70 metres apart** that don't share a parent station as the two sides of one road. That gave **2,587 pairs** (1,933 of them share a name exactly). I kept the **962 pairs with at least 400 scheduled arrivals a day**. Those are the busy ones.

### Step 2: ask Amazon Location to walk between them

For every pair, one `CalculateRoutes` call with `TravelMode: Pedestrian`, from stop A to stop B. If there's a crossing, the walk comes back only a little longer than the straight line. If there isn't, the router has to go find the next place a person on foot can get across, and the walk balloons.

Before trusting this on 962 pairs, I checked it. I started with a pair where I expected a crossing, Veerasandra on Hosur Road. The router came back with 49 m for a 41 m gap, so it does find crossings when they exist. Then I tried eight more busy pairs:

| Stop pair | Straight line | Walked route | Ratio |
|---|---:|---:|---:|
| Veerasandra, Hosur Road (check) | 41 m | 49 m | 1.2× |
| Chandapura | 37 m | 43 m | 1.2× |
| Kodigehalli Gate | 54 m | 81 m | 1.5× |
| Sadahalli Gate | 52 m | 97 m | 1.9× |
| T Dasarahalli | 32 m | 448 m | 14× |
| Kalamandira Marathahalli Bridge | 51 m | 768 m | 15× |
| Garvebhavipalya | 49 m | 894 m | 18× |
| Bellanduru Petrol Bunk | 36 m | 936 m | 26× |
| Neraluru Gate | 36 m | 1,732 m | 48× |

The median across the eight was **14 times** the straight line. The signal was obvious, so the walking network became the crossing detector.

### Step 3: decide what counts as a gap, and rank them

A pair is a **gap** when the walk is **at least 3× the straight line and more than 150 m longer**. Both conditions matter: the first catches detours, the second ignores tiny gaps where 3× is still a short walk.

That flagged **285 of the 962 busy pairs**.

Extra walking time uses 80 m a minute (about 4.8 km/h). The list is ranked by **extra minutes × buses a day**, so a long detour at a quiet stop doesn't outrank a moderate one at a stop with 2,000 buses.

---

## What you can explore

### The whole city at once

![Map overview: 285 stop pairs across Bengaluru](https://d3sb0ns6j3z1es.cloudfront.net/article/06-map-overview.png)

Each dot is a stop pair. **Colour is the extra walking time** (amber is a few minutes, red is 15+), and **size is buses a day**. Red rings are police-named blackspots, and red lines are the high-risk corridors from the report.

The first thing I noticed when this loaded: the gaps aren't scattered. They run in lines along the big radial roads out of the city: Ballari Road towards the airport, Hosur Road towards Electronic City, Tumkur Road, Old Madras Road, and around the Outer Ring Road.

### Fix these first

The left panel is the ranked list of all 285. You can:

- **Filter by traffic**: 400+, 1,000+ or 2,000+ buses a day
- **Toggle "Near a blackspot"** to keep only the 21 gaps within 500 m of a police-named location
- **Search** by stop or junction name

### Open any crossing

![Byatarayanapura Flyover: 25 m apart, 5.4 km walk](https://d3sb0ns6j3z1es.cloudfront.net/article/07-map-byatarayanapura.png)

Clicking a stop flies to it and draws **the actual walk Amazon Location returned**, from stop A to stop B. The outbound and return legs are drawn slightly apart, so you can see the route go up the road and come back down. The card shows:

- the straight-line gap against the walked distance, as two bars
- extra minutes on foot, how many times longer the walk is, and buses a day
- the police blackspot within 500 m, with its fatality count where the report table is unambiguous
- both stop names, so you can find them on the ground
- **Copy link**, which gives you a URL like `map.html?crossing=39269-39270` that reopens this exact crossing

### Gaps next to the places the police already flagged

![Near a blackspot filter: Singasandra Metro Station](https://d3sb0ns6j3z1es.cloudfront.net/article/08-map-singasandra-named.png)

With **Near a blackspot** on, the list drops to 21. **Singasandra Metro Station** on Hosur Road is #3 overall: the stops are 52 m apart, the walk is 2.2 km, and **2,044 buses** a day stop there. It sits within 500 m of Singasandra, which is on the police list.

### Corridor walks: the short way vs. the safe way

![Corridor walk at Bommanahalli: 92 m direct vs 852 m off Hosur Road](https://d3sb0ns6j3z1es.cloudfront.net/article/09-map-corridor-walk.png)

The second tab flips the question around. Sometimes a short crossing exists, but it's on a stretch the police list as high-risk. **What does it cost to stay off it?**

Each of these five draws two Amazon Location pedestrian routes between the same two stops: the direct walk (dashed red) and a walk that treats the police-named corridor as an area to avoid (green).

| Where | Corridor (police report) | Deaths 2021–23 | Direct walk | Staying off the corridor |
|---|---|---:|---:|---:|
| Bommanahalli | Hosur Road, Silk Board to Veerasandra | 26 | 92 m | 852 m |
| Kodigehalli Gate | Ballari Road | 12 | 69 m | 372 m |
| Bhattarahalli | Old Madras Road | 10 | 95 m | 952 m |
| Babusabpalya | Outer Ring Road | 8 | 76 m | 953 m |
| Marathahalli Bridge | Outer Ring Road | 6 | 57 m | 1,268 m |

At Bommanahalli, the safe walk is **9.3 times** the direct one. That's the choice a pedestrian is making there, every day.

### It works on a phone too

![Mobile view of a crossing card](https://d3sb0ns6j3z1es.cloudfront.net/article/10-map-mobile.png)

---

## What the map showed me

Some of this I expected. Some I didn't.

- **The typical gap is a 26 m road and a 563 m walk.** That's the median across all 285. The median walk is **20 times** the straight line.
- **79 pairs force a walk of more than 1 km, and 20 force more than 2 km.**
- **The worst ratio is at Venkatala flyover**: two stops **15 m apart** with a **4.0 km** walk, which is 265 times the distance.
- **Flyovers show up again and again.** 37 of the 285 gaps are at stops BMTC itself names after a flyover ("FLY"), including **6 of the top 10**. The flyover carries cars over the junction, and the crossing seems to have gone with it.
- **Metro interchanges aren't spared.** 19 gaps are at stops named after metro stations, exactly where people change between train and bus. Singasandra and Beratena Agrahara on Hosur Road each see around 2,000 buses a day and need a 2.2 km walk.
- **149 of the 285 gaps are at stops with 1,000+ buses a day.** These are not quiet roads.

### The top 10

| # | Stop pair | Across the road | Walk | Extra time | Buses a day |
|---:|---|---:|---:|---:|---:|
| 1 | Byatarayanapura Flyover | 25 m | 5.4 km | +67 min | 1,033 |
| 2 | Venkatala / Venkatala Flyover | 25 m | 4.5 km | +55 min | 1,098 |
| 3 | Singasandra Metro Station | 52 m | 2.2 km | +27 min | 2,044 |
| 4 | Beratena Agrahara Metro Station | 50 m | 2.2 km | +27 min | 1,994 |
| 5 | Venkatala / Venkatala Flyover | 15 m | 4.0 km | +50 min | 1,085 |
| 6 | ITI Colony Gate | 37 m | 1.8 km | +22 min | 2,437 |
| 7 | Venkatala Flyover | 21 m | 5.6 km | +69 min | 742 |
| 8 | Horamavu Signal | 57 m | 2.0 km | +24 min | 1,899 |
| 9 | Kogilu Cross / Kogilu Cross Flyover | 30 m | 3.0 km | +37 min | 1,148 |
| 10 | Allalasandra Gate Flyover | 30 m | 3.2 km | +39 min | 1,038 |

---

## How it's built on AWS

![Architecture: Amazon Location Routes and Places, S3, Athena, Iceberg, CloudFront](https://d3sb0ns6j3z1es.cloudfront.net/article/00-architecture.png)

The whole pipeline is Python 3.12 and the AWS CLI, with **no third-party packages**. Everything expensive happens once, offline. The browser only ever reads static files.

### 1. Amazon Location Routes: the crossing detector

This is the core of the project. Each of the 962 busy pairs gets one pedestrian route. Here's the actual request for Byatarayanapura, stop A to stop B:

```json
{
  "Origin": [77.59298, 13.06723],
  "Destination": [77.59318, 13.06734],
  "TravelMode": "Pedestrian",
  "LegGeometryFormat": "Simple"
}
```

From the response I read the leg's `PedestrianLegDetails.Summary.Overview.Distance` and `Duration`, plus the `LineString` geometry that gets drawn on the map. **962 calls, 0 failures.**

**Every response is cached** in `route_cache.jsonl`, keyed by a SHA-256 hash of the exact request. The cache now holds 1,122 responses (pairs, the gate check, corridors and walks). Rerunning the pipeline makes **zero paid calls**, and `export_routes.py` builds the map's route lines straight from the cache.

### 2. Amazon Location Places: putting the police report on the map

The report names junctions like "Byatarayanapura Junction". It doesn't give coordinates. Each name goes through `Geocode`, biased towards the city centre:

```json
{
  "QueryText": "Byatarayanapura Junction, Ballari Road, Bengaluru, India",
  "MaxResults": 3,
  "BiasPosition": [77.59, 12.97]
}
```

Geocoding Indian junction names isn't always clean. When the geocoder returned a different place and BMTC had a stop cluster with that name, I used the stop cluster instead. Summanahalli was the case that needed it.

The **corridors** ("Silk Board Junction to Veerasandra Bus Stop") are two geocoded endpoints joined by a `TravelMode: Car`, `ShortestRoute` call, so the line follows the real road. If the routed length came out far from the length printed in the report, I dropped that corridor rather than draw a wrong line. **11 corridors** survived that check.

### 3. Amazon Location Routes again: walks that avoid a corridor

The "stay off the corridor" walks use the same pedestrian route, with the police corridor passed as an area to avoid. The avoid line is the corridor's own car route from step 2, simplified. This is Bommanahalli on Hosur Road:

```json
{
  "Origin": [77.6285, 12.90696],
  "Destination": [77.62847, 12.90678],
  "TravelMode": "Pedestrian",
  "LegGeometryFormat": "Simple",
  "Avoid": {
    "Areas": [{
      "Geometry": {
        "Corridor": {
          "LineString": [[77.620167, 12.916586], "…", [77.676399, 12.84081]],
          "Radius": 45
        }
      }
    }]
  }
}
```

For each corridor, the pipeline tries the busiest same-name stop pairs along it, with a 45 m and a 90 m avoid radius. It keeps a walk only if the detour is believable: 2 to 25 extra minutes, at least 1.7× the direct walk, and under 2 km. The difference between the two answers is the cost of staying safe.

### 4. Amazon S3, Athena and Apache Iceberg: the join

The scored pairs and the geocoded blackspots are written to S3 as JSON lines under `staging/`. Athena reads them as two external tables, and one `CREATE TABLE AS` query writes an **Iceberg table** (`safe_crossing.crossings`, Parquet, registered in the AWS Glue Data Catalog). For each pair it computes the haversine distance to every blackspot, keeps the nearest one, and attaches it if it's within 500 m:

```sql
CREATE TABLE safe_crossing.crossings
WITH (table_type = 'ICEBERG', format = 'PARQUET', is_external = false,
      location = 's3://<bucket>/iceberg/crossings/') AS
WITH distances AS (
  SELECT p.*, b.name AS blackspot_name, b.road AS blackspot_road,
         b.fatalities AS blackspot_fatalities,
         2 * 6371000 * asin(least(1.0, sqrt(
           pow(sin(radians(b.lat - p.lat) / 2), 2)
           + cos(radians(p.lat)) * cos(radians(b.lat))
             * pow(sin(radians(b.lon - p.lon) / 2), 2)))) AS blackspot_m
  FROM safe_crossing.pairs_json p
  CROSS JOIN safe_crossing.blackspots_json b
),
ranked AS (
  SELECT *, row_number() OVER (PARTITION BY pair_id ORDER BY blackspot_m) AS rn
  FROM distances
)
SELECT pair_id, name, straight_m, walk_m, extra_min, arrivals, impact, is_gap,
       CASE WHEN blackspot_m < 500 THEN blackspot_name END AS blackspot,
       CASE WHEN blackspot_m < 500 THEN blackspot_fatalities END AS blackspot_fatalities
       -- (full column list in sql/create_crossings.sql)
FROM ranked
WHERE rn = 1;
```

That's where **"21 of 285 gaps sit within 500 m of a police-named place"** comes from. A second query (`sql/export_crossings.sql`) selects the gaps ordered by impact, and the pipeline turns the result into `crossings.geojson`.

I used a real table here, not a script that joins in memory, because the next step is obvious: BMTC publishes a new GTFS feed, the pipeline reruns, and the table should keep history so you can see which gaps closed.

### 5. Amazon S3, CloudFront and Amazon Location Maps: serving it

- The site and the GeoJSON live in a **private S3 bucket** with public access blocked. **CloudFront** serves it over HTTPS through **Origin Access Control**.
- The map is **MapLibre GL** on the **Amazon Location Maps Standard style** (dark).
- The browser uses an **Amazon Location API key that only works from the CloudFront domain**:

```json
{
  "KeyName": "safe-crossing",
  "Restrictions": {
    "AllowActions": ["geo-maps:*", "geo-places:Geocode", "geo-places:ReverseGeocode",
                     "geo-places:Suggest", "geo-places:GetPlace", "geo-routes:CalculateRoutes"],
    "AllowResources": ["arn:aws:geo-maps:us-east-1::provider/default",
                       "arn:aws:geo-places:us-east-1::provider/default",
                       "arn:aws:geo-routes:us-east-1::provider/default"],
    "AllowReferers": ["https://d3sb0ns6j3z1es.cloudfront.net/*"]
  }
}
```

**A click never calls a live routing API.** Every route on the map was computed once and shipped as GeoJSON. So clicking is instant, a visitor can't hit a rate limit or a timeout, and a busy day doesn't cost anything extra. The only live Amazon Location traffic is basemap tiles.

---

## Proof it's running

These are from my AWS account (`us-east-1`).

**Amazon Location Service: the referrer-locked API key the map uses**

![Amazon Location console: API key safe-crossing](https://d3sb0ns6j3z1es.cloudfront.net/article/console-location.png)

**Amazon Athena: querying the Iceberg table**

![Athena console: query on safe_crossing.crossings](https://d3sb0ns6j3z1es.cloudfront.net/article/console-athena.png)

**Amazon S3: site files, staging data and the Iceberg table in one bucket**

![S3 console: safe-crossing bucket](https://d3sb0ns6j3z1es.cloudfront.net/article/console-s3.png)

**Amazon CloudFront: the distribution serving the map**

![CloudFront console: distribution deployed](https://d3sb0ns6j3z1es.cloudfront.net/article/console-cloudfront.png)

And the same from the AWS CLI (account ID trimmed):

```text
$ aws glue get-table --database-name safe_crossing --name crossings \
    --query "Table.{Name:Name,Params:Parameters,Location:StorageDescriptor.Location}"
{
    "Name": "crossings",
    "Params": {
        "metadata_location": "s3://safe-crossing-…/iceberg/crossings/metadata/…metadata.json",
        "table_type": "ICEBERG"
    },
    "Location": "s3://safe-crossing-…/iceberg/crossings"
}

$ aws cloudfront get-distribution --id E1967YVSS2YTKE \
    --query "Distribution.{Status:Status,Domain:DomainName,Origin:DistributionConfig.Origins.Items[0].DomainName,Enabled:DistributionConfig.Enabled}"
{
    "Status": "Deployed",
    "Domain": "d3sb0ns6j3z1es.cloudfront.net",
    "Origin": "safe-crossing-….s3.us-east-1.amazonaws.com",
    "Enabled": true
}
```

---

## Reuse it in your city

Nothing here is specific to Bengaluru except the inputs. You need:

1. **A GTFS feed** for your city's buses
2. **A list of named dangerous places** (a police report, a city road safety plan, or your own list)
3. **An AWS account** with Amazon Location Service in your region

Then run:

```text
python pipeline/ingest_gtfs.py     # pair opposite-side stops, count arrivals
python pipeline/score_routes.py    # one pedestrian route per busy pair (cached)
python pipeline/places.py          # geocode places, draw corridors, avoid-corridor walks
python pipeline/load_iceberg.py    # stage on S3, Athena CTAS into Iceberg, export GeoJSON
python pipeline/export_routes.py   # walked routes from the cache, no new calls
python pipeline/deploy.py          # S3 + CloudFront + referrer-locked API key
```

The thresholds are plain constants: 12–70 m to count as opposite stops, 400 buses a day to be "busy", 3× and +150 m to be a gap, 500 m to be "near" a blackspot. Change them for your city.

The pattern is the reusable part. **Any question shaped like "where is the network missing a link?" can be answered by routing between points that should be close and flagging the ones that aren't.** Swap bus stops for school gates and homes, or hospital entrances and parking.

---

## What it can't tell you

I'd rather say this than have someone find it:

- **A long walk can also mean the map is missing a crossing that really exists.** Either way, the spot is worth a look: either there's no safe crossing, or the map that navigation apps rely on doesn't know about it.
- **Buses a day isn't riders.** It's scheduled arrivals. Ridership per stop isn't in the open data.
- **No crash coordinates.** The police publish names, so blackspots are geocoded names. Fatality counts are shown only where the report's table reading is unambiguous.
- **Some corridors were dropped.** If the geocoded endpoints didn't match the length printed in the report, the corridor isn't drawn. The ones you see are the ones that matched.

---

## What's next

- **Walk the top 20 in person** and mark which are true gaps and which are missing map data.
- **Keep history in the Iceberg table**, one snapshot per GTFS release, so the map can show which gaps closed and which new ones appeared.
- **A "there's a crossing here" button**, so people who use these stops can correct the map.
- **Other cities.** The pipeline only needs a GTFS feed and a list of names.

---

## Credits and licences

- Bus stops and schedules: BMTC GTFS, September 2026, published by [Vonter](https://github.com/Vonter/bmtc-gtfs) under ODbL. Derived stop data is ODbL.
- Blackspots and corridors: Bengaluru Traffic Police Road Safety Report 2023, public domain, via [OpenCity](https://data.opencity.in/dataset/bengaluru-traffic-police-road-safety-reports).
- Routes, geocoding and basemap: Amazon Location Service.

**Open the map, search for a stop you use, and see what's across the road:** https://d3sb0ns6j3z1es.cloudfront.net/map.html
