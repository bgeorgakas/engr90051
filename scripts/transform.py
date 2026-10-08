#!/usr/bin/env python3
"""
Build the map-ready layers in data/ from the raw downloads in data/raw/
(run scripts/extract.py first). No network access needed.

Outputs:
  - catchment.json            Elizabeth Street catchment boundary.
  - flood_extent_2100.json    Union of SBO and LSIO planning boundaries.
                              Legacy filename, NOT a confirmed 2100 model.
  - flood_extent_current.json Synthetic demonstration geometry, not used
                              by the current frontend.
  - flood_extent_2010.json    Synthetic demonstration geometry, NOT an
                              observed or modelled 2010 event.

The two synthetic layers are arbitrary erosions of the planning-boundary
union; the "2010" demo also contains randomly placed restoration areas.
Their area fractions, nesting and random seed are demonstration choices,
not hydraulic results or evidence about historical flooding.

For official baseline and future model snapshots, use
scripts/fetch_official_flood_data.py. This legacy script does not write
data/official/ and cannot replace the official importer.

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
        print(f"  legacy {label:>8}: {extent.area / 1e4:5.1f} ha ({share:.0%} of planning union)")

    save_extent(
        extent_2100,
        DATA_DIR / "flood_extent_2100.json",
        {
            "scenario": "planning_overlay_union",
            "label": "Planning boundaries (SBO/LSIO; not a 2100 model)",
            "data_kind": "planning_overlay",
            "synthetic": False,
            "method": "Union of SBO and LSIO planning overlays intersecting the catchment.",
        },
    )
    save_extent(
        extent_2010,
        DATA_DIR / "flood_extent_2010.json",
        {
            "scenario": "synthetic_demo_2010",
            "label": "Synthetic demo (not observed 2010 flooding)",
            "data_kind": "synthetic_demo",
            "synthetic": True,
            "method": (
                f"Dummy data. Planning-boundary union eroded {baseline_distance:.2f}m to "
                f"{EVENT_2010_AREA_FRACTION:.0%} of its area, restored to the full planning union "
                f"inside {STORM_CELL_COUNT} random storm cells (seed {RANDOM_SEED})."
            ),
        },
    )
    save_extent(
        extent_current,
        DATA_DIR / "flood_extent_current.json",
        {
            "scenario": "synthetic_demo_current",
            "label": "Synthetic demo — current placeholder",
            "data_kind": "synthetic_demo",
            "synthetic": True,
            "method": (
                f"Dummy data. Planning-boundary union eroded {current_distance:.2f}m to "
                f"{CURRENT_AREA_FRACTION:.0%} of its area."
            ),
        },
    )


if __name__ == "__main__":
    main()
