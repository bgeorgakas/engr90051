# Elizabeth Street flood-map prototype

Leaflet-based research prototype. The default flood overlay now uses an
official Melbourne Water model snapshot, not the old synthetic "current" layer.
This is not a live warning service or an address-level flood-risk assessment.

## Run locally

From this repository, run `python3 -m http.server 8765 --bind 127.0.0.1`, then
open <http://127.0.0.1:8765/>. Opening `index.html` as a `file://` URL will not
reliably load the JSON files. Internet access is still needed for Leaflet,
basemap tiles, address search and linked historic media.

## Official data now connected

Source: [Melbourne Water CMA, Victorian planning flood-control service, layer 11](https://spatial.planning.vic.gov.au/server/rest/services/planning_flood_control/MapServer/11).
Only `ELIZABETH ST DRAIN (CITY)` records with `FLOOD_EVENT = 1PCT` are included.

| Layer | Study date | Source scenario | Object IDs | Default |
| --- | --- | --- | --- | --- |
| Baseline, blue fill | 2020-08-13 | Existing Condition | 596 | On |
| Future, orange dashed outline | 2017-08-31 | Yr 2100, RCP 8.5 | 7, 8, 9 | Off |

These are **official model outputs**, not observed flood events or real-time
conditions. A 1% AEP event has a 1% annual exceedance probability; it is not
restricted to occurring once in 100 years.

The studies record different upstream limits (Lytton Street versus Therry
Street) as well as different dates. Do not interpret their difference as a
like-for-like estimate of climate change, or expect the future polygon to
contain every part of the baseline. No water-depth, high/medium/low risk,
current warning or "safe" label is inferred. Outside the displayed polygons
does not establish safety or assessed coverage.

### Snapshot provenance and refresh

`data/official/manifest.json` records the source/query URLs, retrieval time,
study dates, feature IDs/counts, coordinate counts and SHA-256 file hashes.
The two GeoJSON files retain all returned 2D WGS84 coordinates, holes and small
polygons. No simplification, clipping, buffering or synthetic geometry is used.
Structural validation is not hydraulic-model verification or a full topology audit.

Refresh with `python3 scripts/fetch_official_flood_data.py` (Python standard
library only). It checks source IDs, record counts, scenario fields, dates and
geometry before replacing snapshots. If a study date/count changes, the import
fails so labels can be reviewed; it does not silently accept a new scenario.
Existing snapshots are not automatically refreshed when visitors open the map.

**Publishing checkpoint:** the source item's `licenseInfo` was blank when
retrieved. Public access alone does not confirm redistribution permission.
Confirm applicable terms/permission before publishing or pushing these local
snapshots to a public repository. No deployment has been performed here.

## Existing prototype layers

- Catchment boundary and historic stories remain available and on by default.
- `data/flood_extent_2100.json` is a legacy filename for merged SBO/LSIO
  planning boundaries, not a verified uniform 2100 model; off by default.
- `data/flood_extent_2010.json` is synthetic demonstration geometry, not an
  observed 2010 event; off by default.
- `data/flood_extent_current.json` is the old synthetic placeholder, retained
  on disk but no longer loaded by the website.
- `scripts/extract.py` and `scripts/transform.py` are the older planning/demo
  workflow. They do not produce or replace `data/official/`.

The original legacy coordinates have been preserved; their misleading metadata
labels have been corrected. New official model files are kept separately.

## What is still not implemented

Address search locates a place and explicitly says it has not calculated flood
risk. Point-in-polygon lookup, address-specific explanation, flood depths,
live alerts, drain reporting and user submissions are not implemented by this
data-integration change. Data absence, missing coverage and a point outside an
extent must remain distinguishable if address lookup is added later.

## Checks

```sh
node --test tests/*.test.js
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts -p 'test_fetch_official_flood_data.py' -v
```

Manual checks: baseline on/future off at startup; toggle the future outline;
open a polygon's source popup; expand source details; search a public place;
open a historic story; check a narrow phone viewport. Official loading failures
must be visible with a retry button, not silently treated as no flood extent.
