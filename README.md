# Elizabeth Street flood-map prototype

Leaflet-based research prototype. The map restores the team's original three
layers, original display names and colours. These are planning/demo geometry,
not verified current/2010/2100 flood scenarios. Address results use these same
three layers only. This is not a live warning service or a flood-risk assessment.

## Run locally

From this repository, run `python3 -m http.server 8765 --bind 127.0.0.1`, then
open <http://127.0.0.1:8765/>. Opening `index.html` as a `file://` URL will not
reliably load the JSON files. Internet access is still needed for Leaflet,
basemap tiles, address search and linked historic media.

## Active prototype layers

All three layers are on by default, drawn in this order. Catchment and historic
stories remain available and on by default. `js/prototype-data.js` is the shared
catalogue for loading, validation, map controls and address-result metadata.

| Original display name | File | Actual data |
| --- | --- | --- |
| 2100 — 1% AEP (climate change) | `data/flood_extent_2100.json` | Merged SBO/LSIO planning boundaries, not a verified 2100 model |
| 2010 flood event (indicative) | `data/flood_extent_2010.json` | Synthetic shapes, not an observed or modelled 2010 flood |
| Current day — 1% AEP (indicative) | `data/flood_extent_current.json` | Synthetic shapes, not a current-day 1% AEP model |

The names are retained for continuity, not as evidence of a date, probability or
event. Persistent notices and address-card badges explain these limitations.
The demo shapes were made by reducing the planning area towards 70% (current)
and 85% (2010); the latter also restores portions within random storm cells.
Their nesting/differences are design choices, not hydraulic or climate evidence.
Original coordinates and honest file metadata are unchanged.

Loading fails visibly if provenance does not match the catalogue or geometry is
invalid. Failed layers can be retried without duplicating controls or changing
the user's visibility choices. Layer and drawing order do not depend on download
completion order.

## Archived official model snapshots — not used by this page

The two separately imported official layers have been removed from both the map
and address lookup at the team's request. The following files/importer are kept
in the repository, not deleted. The frontend does not request `data/official/`.

Source: [Melbourne Water CMA, Victorian planning flood-control service, layer 11](https://spatial.planning.vic.gov.au/server/rest/services/planning_flood_control/MapServer/11).
Only `ELIZABETH ST DRAIN (CITY)` records with `FLOOD_EVENT = 1PCT` are included.

| Archived layer | Study date | Source scenario | Object IDs | Frontend |
| --- | --- | --- | --- | --- |
| Baseline | 2020-08-13 | Existing Condition | 596 | Not loaded |
| Future | 2017-08-31 | Yr 2100, RCP 8.5 | 7, 8, 9 | Not loaded |

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

`scripts/extract.py` and `scripts/transform.py` build the active planning/demo
layers. They do not produce or replace the archived `data/official/` files.

## Address results

Search for a public address/place, then explicitly select a matching result.
The panel checks that one approximate geocoded point against **all three active
prototype layers**, regardless of which layers are visible. It distinguishes
inside, on a polygon boundary, outside the displayed area, loading, and
unavailable data. Holes and every small component are retained in the checks.
Permanent badges identify planning and synthetic layers; an intersection is
only a geometry match, never a real flood-risk result. Archived official model
snapshots are not loaded or used for address results.

The catchment check describes the project's geographic scope, **not** the
assessed flood coverage. These prototype shapes are not a flood assessment.
No intersection therefore does not prove the address was assessed,
does not mean safe, and is not a property-level risk rating. Geocoded points
can represent a street/place centre rather than a building or entrance; users
must verify the pin. This is not an engineering or emergency assessment.

Results show the original layer name, actual data type, its limitations and
links to the local layer data and generation script. Failed loads can be retried; the
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

Manual checks: all three original layers on at startup, no separate official
baseline/future entries or network requests; toggle each original layer;
open a polygon's provenance popup; search/select a public place; check all three
prototype results and permanent type warnings; change/close a search; open a
historic story; check a narrow phone viewport. Loading failures must be visible
with a retry button, not silently treated as an outside or safe result.
