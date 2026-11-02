-- Rows the map draws. Run after sql/create_crossings.sql.
SELECT
  pair_id,
  name,
  same_name,
  lon,
  lat,
  straight_m,
  walk_m,
  extra_m,
  extra_min,
  arrivals,
  impact,
  desc_a,
  desc_b,
  blackspot,
  blackspot_road,
  division,
  blackspot_fatalities
FROM safe_crossing.crossings
WHERE is_gap
ORDER BY impact DESC;
