## The Problem

Two BMTC bus stops on opposite sides of the Byatarayanapura flyover are 25 metres apart. Walking between them takes 5.4 kilometres, because the nearest place to cross is 2.7 km up the road.

Bengaluru recorded 282 pedestrian deaths in 2023, 31% of all road deaths. Byatarayanapura is a police-listed blackspot, with 11 deaths between 2021 and 2023. Yet there's no city-wide map of where pedestrians face long detours to cross.

I built one: it finds these gaps, ranks them by impact, and shows where they overlap with known blackspots.

## Dataset Used

- **BMTC GTFS feed (Sept 2026, ODbL):** 9,960 bus stops and every scheduled trip.
- **Bengaluru Traffic Police Road Safety Report 2023:** named blackspots and high-risk corridors.

## AWS Services Used

- **Amazon Location Routes:** pedestrian routes between stop pairs, and walks that avoid risky corridors
- **Amazon Location Places:** geocodes junction names from the police report
- **Amazon Location Maps:** basemap
- **Amazon S3 + Athena + Apache Iceberg:** joins each gap to the nearest blackspot
- **Amazon CloudFront:** serves the map and GeoJSON

## How I Built It

I paired bus stops 12–70 m apart on opposite sides of a road and kept the 962 busiest pairs (400+ buses a day).

Amazon Location Routes walks each pair. Pedestrian routing only crosses where someone on foot can, so a long route means a missing crossing. In a first test on eight busy pairs, the median walk was 14 times the straight line.

Pairs whose walk is at least 3x the gap and 150 m longer were flagged: 285 gaps, ranked by extra walking time times daily buses.

Athena joins each gap to the nearest blackspot within 500 m and stores the result as an Iceberg table on S3. It's exported as GeoJSON and served through CloudFront. Every route is cached, so a click never waits on a live API.

## Exploring the Map

- **Fix these first:** 285 gaps ranked, filterable by buses and blackspots
- **Crossing cards:** click a stop to see the real walking route
- **Corridor walks:** the direct walk vs. one that avoids a police-listed corridor
- **Shareable links:** every crossing has its own URL

## What I Found

- **Byatarayanapura Flyover:** 25 m apart, 5.4 km walk
- **Singasandra Metro:** 52 m apart, 2.2 km walk, 2,044 buses daily
- **37 gaps** are at flyovers, including 6 of the top 10; **19** are at metro stations
- **21 gaps** lie within 500 m of a police blackspot
- **Bommanahalli:** avoiding a risky stretch of Hosur Road turns a 92 m walk into 852 m

These are potential gaps inferred from routing data. A long route can also mean the map is missing a crossing, so on-ground checks are needed.

## Beyond Bengaluru

Any city with a GTFS feed and a list of dangerous places can rerun the same pipeline.

**Explore:** [Interactive Map](https://d3sb0ns6j3z1es.cloudfront.net/map.html) | [Demo Video](https://youtu.be/XKfD63EnCOY)
