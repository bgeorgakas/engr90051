#!/usr/bin/env python3
"""
Build the map-ready layers in data/ from the raw downloads in data/raw/
(run scripts/extract.py first). No network access needed.

Outputs:
  - catchment.json            Elizabeth Street catchment boundary.
  - flood_extent_2100.json    1% AEP flood extent in 2100. Real data: the
                              SBO and LSIO planning overlays dissolved
                              together, which already include climate
                              change assumptions.
  - flood_extent_current.json Current-day 1% AEP flood extent. DUMMY DATA.
  - flood_extent_2010.json    2010 flood event extent. DUMMY DATA.

The real current-day and 2010 extents exist but are not public, so both are
derived from the 2100 extent for the prototype:

  - Current day: the 2100 extent eroded inward (negative buffer) until
    CURRENT_AREA_FRACTION of its area is left. Flow paths narrow towards
    their centrelines and thin fringes drop out.
  - 2010: eroded less, to EVENT_2010_AREA_FRACTION, because the event was
    around a 1 in 200 year flood (Water Technology estimate) and so larger
    than a 1 in 100. A real storm is not uniform, so inside a few randomly
    placed "storm cells" the extent reaches the full 2100 extent.

So current ⊆ 2010 ⊆ 2100. The area fractions are placeholders, not sourced
figures. The random seed is fixed, so reruns give identical files.

Usage:
    python scripts/transform.py
"""

import json
import random
from pathlib import Path

import geopandas as gpd
import shapely
from shapely.geometry import Point, mapping, shape
from shapely.ops import unary_union

from extract import CATCHMENTS_RAW_PATH, DATA_DIR, RAW_CACHE_DIR, load_elizabeth_street_catchment

METRIC_CRS = "EPSG:28355"  # GDA94 / MGA zone 55, so buffers and areas are in metres
OVERLAY_NAMES = ["sbo", "lsio"]

SIMPLIFY_TOLERANCE_M = 0.2
MIN_FRAGMENT_AREA_M2 = 20
COORDINATE_DECIMALS = 6  # ~0.1m

CURRENT_AREA_FRACTION = 0.70
EVENT_2010_AREA_FRACTION = 0.85
STORM_CELL_COUNT = 3
STORM_CELL_RADIUS_M = (250, 400)
RANDOM_SEED = 2010


def load_overlay_union(raw_dir: Path):
    """Dissolve all raw overlay features into one geometry in METRIC_CRS."""
    geometries = []
    for name in OVERLAY_NAMES:
        path = raw_dir / f"{name}.geojson"
        if not path.exists():
            raise SystemExit(f"Missing {path} — run scripts/extract.py first.")
        features = json.loads(path.read_text())["features"]
        print(f"Loaded {len(features)} {name.upper()} feature(s)")
        geometries.extend(shape(feature["geometry"]) for feature in features)

    if not geometries:
        raise SystemExit("No SBO or LSIO features found in data/raw/.")

    projected = gpd.GeoSeries(geometries, crs="EPSG:4326").to_crs(METRIC_CRS)
    union = shapely.make_valid(unary_union(projected.values))
    return shapely.make_valid(union.simplify(SIMPLIFY_TOLERANCE_M, preserve_topology=True))


def drop_small_fragments(geometry):
    polygons = geometry.geoms if hasattr(geometry, "geoms") else [geometry]
    return unary_union([p for p in polygons if p.area >= MIN_FRAGMENT_AREA_M2])


def erode(geometry, distance_m: float):
    return drop_small_fragments(geometry.buffer(-distance_m, quad_segs=2))


def erode_to_area_fraction(geometry, fraction: float, tolerance: float = 0.005):
    """Erode inward by whatever distance leaves `fraction` of the area."""
    target = geometry.area * fraction
    low, high = 0.0, 1.0
    while erode(geometry, high).area > target:
        high *= 2

    while True:
        distance = (low + high) / 2
        eroded = erode(geometry, distance)
        if abs(eroded.area - target) <= geometry.area * tolerance or high - low < 1e-4:
            return eroded, distance
        if eroded.area > target:
            low = distance
        else:
            high = distance


def random_storm_cells(catchment, rng: random.Random):
    """Circles centred at random points inside the catchment."""
    min_x, min_y, max_x, max_y = catchment.bounds
    cells = []
    while len(cells) < STORM_CELL_COUNT:
        centre = Point(rng.uniform(min_x, max_x), rng.uniform(min_y, max_y))
        if catchment.contains(centre):
            cells.append(centre.buffer(rng.uniform(*STORM_CELL_RADIUS_M)))
    return unary_union(cells)


def round_coordinates(coordinates):
    if isinstance(coordinates[0], (int, float)):
        return [round(value, COORDINATE_DECIMALS) for value in coordinates]
    return [round_coordinates(part) for part in coordinates]


def save_extent(geometry, path: Path, properties: dict) -> None:
    wgs84 = gpd.GeoSeries([geometry], crs=METRIC_CRS).to_crs(epsg=4326).iloc[0]
    wgs84 = shapely.set_precision(wgs84, 10**-COORDINATE_DECIMALS)
    geojson_geometry = mapping(wgs84)
    feature = {
        "type": "Feature",
        "properties": properties,
        "geometry": {
            "type": geojson_geometry["type"],
            "coordinates": round_coordinates(geojson_geometry["coordinates"]),
        },
    }
    collection = {"type": "FeatureCollection", "features": [feature]}
    path.write_text(json.dumps(collection, separators=(",", ":")))
    print(f"Saved {path} ({path.stat().st_size / 1e6:.1f} MB)")


def main():
    if not CATCHMENTS_RAW_PATH.exists():
        raise SystemExit(f"Missing {CATCHMENTS_RAW_PATH} — run scripts/extract.py first.")

    catchment_gdf = load_elizabeth_street_catchment(CATCHMENTS_RAW_PATH)
    catchment_path = DATA_DIR / "catchment.json"
    catchment_path.write_text(catchment_gdf.to_json(separators=(",", ":")))
    print(f"Saved {catchment_path}")
    catchment = unary_union(catchment_gdf.to_crs(METRIC_CRS).geometry)

    extent_2100 = load_overlay_union(RAW_CACHE_DIR)

    extent_current, current_distance = erode_to_area_fraction(extent_2100, CURRENT_AREA_FRACTION)

    baseline_2010, baseline_distance = erode_to_area_fraction(extent_2100, EVENT_2010_AREA_FRACTION)
    storm_cells = random_storm_cells(catchment, random.Random(RANDOM_SEED))
    extent_2010 = drop_small_fragments(unary_union([baseline_2010, extent_2100.intersection(storm_cells)]))

    # Sliver tolerance for floating point noise in the overlay operations.
    assert extent_current.difference(extent_2010).area < 1, "current-day extent is not inside 2010 extent"
    assert extent_2010.difference(extent_2100).area < 1, "2010 extent is not inside 2100 extent"

    for label, extent in [("2100", extent_2100), ("2010", extent_2010), ("current", extent_current)]:
        share = extent.area / extent_2100.area
        print(f"  {label:>8}: {extent.area / 1e4:5.1f} ha ({share:.0%} of 2100)")

    save_extent(
        extent_2100,
        DATA_DIR / "flood_extent_2100.json",
        {
            "scenario": "2100_aep1",
            "label": "2100 — 1% AEP (climate change)",
            "synthetic": False,
            "method": "Union of SBO and LSIO planning overlays intersecting the catchment.",
        },
    )
    save_extent(
        extent_2010,
        DATA_DIR / "flood_extent_2010.json",
        {
            "scenario": "2010_event",
            "label": "2010 flood event (indicative)",
            "synthetic": True,
            "method": (
                f"Dummy data. 2100 extent eroded {baseline_distance:.2f}m to "
                f"{EVENT_2010_AREA_FRACTION:.0%} of its area, restored to the full 2100 extent "
                f"inside {STORM_CELL_COUNT} random storm cells (seed {RANDOM_SEED})."
            ),
        },
    )
    save_extent(
        extent_current,
        DATA_DIR / "flood_extent_current.json",
        {
            "scenario": "current_aep1",
            "label": "Current day — 1% AEP (indicative)",
            "synthetic": True,
            "method": (
                f"Dummy data. 2100 extent eroded {current_distance:.2f}m to "
                f"{CURRENT_AREA_FRACTION:.0%} of its area."
            ),
        },
    )


if __name__ == "__main__":
    main()
