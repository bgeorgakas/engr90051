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

## Address results

Search for a public address/place, then explicitly select a matching result.
The panel checks that one approximate geocoded point against **both** official
model snapshots, regardless of which layers are visible. It distinguishes
inside, on a polygon boundary, outside the displayed extent, loading, and
unavailable data. Holes and every small component are retained in the checks.
Synthetic demonstration layers and planning overlays are never used to produce
an address result.

The catchment check describes the project's geographic scope, **not** the
hydraulic model's assessed coverage. We do not have a model-study coverage
boundary. No intersection therefore does not prove the address was assessed,
does not mean safe, and is not a property-level risk rating. Geocoded points
can represent a street/place centre rather than a building or entrance; users
must verify the pin. This is not an engineering or emergency assessment.

Results show the relevant scenario, study date, source record IDs when matched,
snapshot date and official source link. Failed model loads can be retried; the
selected result updates once data arrives. Editing/closing/starting another
search cancels stale requests and clears stale pins. The panel supports keyboard
controls, candidate selection, map recentering and a mobile bottom-sheet layout.

### Address service and privacy

The existing OpenStreetMap/Nominatim service is retained for this **low-volume
course prototype**, with submit-only requests (no autocomplete), a timeout,
at least one second between requests per client, and an in-memory result cache.
Search strings are sent to the configured provider, not stored by this app in
localStorage, analytics, or a backend. Do not enter personal/confidential data.
The screen links to the [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/).

**Use one tester at a time with the public endpoint.** Nominatim's maximum of
one request per second applies to the whole application, across all users.
The browser cooldown is not a shared multi-user limiter. Before wider user
testing, provide a compliant shared proxy with aggregate pacing/caching or
choose an appropriate alternative provider. No geolocation or reverse lookup
is performed.

`data/search-config.json` can disable search (`enabled: false`) or switch to
a Nominatim-compatible endpoint without editing the browser module. Invalid,
disabled or unavailable configuration fails closed without sending searches.
Do not put private API credentials in this public file. Provider changes must
also update the visible attribution/privacy notice and satisfy its terms.

## What is still not implemented

Property-wide/building-footprint assessment, verified model-study coverage,
flood depths, live alerts, drain reporting and user submissions remain outside
this prototype. There is no shared geocoding backend/rate limiter or validated
address risk grade.

## Checks

```sh
node --test tests/*.test.js
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts -p 'test_fetch_official_flood_data.py' -v
```

Manual checks: baseline on/future off at startup; toggle the future outline;
open a polygon's source popup; expand source details; search/select a public place;
check separate scenario results; change/close a search; open a historic story;
check a narrow phone viewport. Official loading failures
must be visible with a retry button, not silently treated as no flood extent.
