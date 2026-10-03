#!/usr/bin/env python3
"""
Download the raw data for the Elizabeth Street catchment flood map into
data/raw/. Nothing here is map-ready; run scripts/transform.py afterwards
to build the layers the map loads.

Sources:
  - Catchment boundaries: Melbourne Water open data
    (https://data-melbournewater.opendata.arcgis.com), "Catchments -
    Waterways and Drains Subcatchments" dataset, saved whole.
  - LSIO / SBO: Vicplan planning scheme overlays
    (https://plan-gis.mapshare.vic.gov.au/.../Vicplan_PlanningSchemeOverlays),
    queried directly for only the features that intersect the
    "ELIZABETH ST DRAIN (CITY)" sub-catchment (the Melbourne CBD one —
    the dataset also contains an unrelated "ELIZABETH ST M.D. (COBURG)"
    sub-catchment in a different suburb). This is a server-side spatial
    filter, not a client-side crop.

Usage:
    python scripts/extract.py [--force-refresh]
"""

import argparse
import json
from pathlib import Path

import geopandas as gpd
import requests
from shapely.geometry.polygon import orient
from shapely.ops import unary_union

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
RAW_CACHE_DIR = DATA_DIR / "raw"

CATCHMENTS_URL = (
    "https://data-melbournewater.opendata.arcgis.com/api/download/v1/items/"
    "15c3c23d7ef140b4a746e7779eae92d7/geojson?layers=1"
)
CATCHMENTS_SOURCE_CRS = "EPSG:28355"  # GDA94 / MGA zone 55, as served by the portal
CATCHMENT_NAME = "ELIZABETH ST DRAIN (CITY)"
CATCHMENTS_RAW_PATH = RAW_CACHE_DIR / "melbourne_water_catchments.geojson"

OVERLAY_LAYERS = {
    "lsio": (
        "https://plan-gis.mapshare.vic.gov.au/arcgis/rest/services/Planning/"
        "Vicplan_PlanningSchemeOverlays/MapServer/15"
    ),
    "sbo": (
        "https://plan-gis.mapshare.vic.gov.au/arcgis/rest/services/Planning/"
        "Vicplan_PlanningSchemeOverlays/MapServer/16"
    ),
}


def download_catchments(force_refresh: bool) -> Path:
    RAW_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = CATCHMENTS_RAW_PATH
    if cache_path.exists() and not force_refresh:
        print(f"Using cached catchments file: {cache_path}")
        return cache_path

    print("Downloading Melbourne Water catchments dataset (~24MB)...")
    response = requests.get(CATCHMENTS_URL, timeout=120)
    response.raise_for_status()
    cache_path.write_bytes(response.content)
    return cache_path


def load_elizabeth_street_catchment(catchments_path: Path) -> gpd.GeoDataFrame:
    gdf = gpd.read_file(catchments_path)
    # The portal's declared CRS ("EPSG:28355") isn't always picked up
    # correctly by GDAL's GeoJSON reader, so set it explicitly.
    gdf = gdf.set_crs(CATCHMENTS_SOURCE_CRS, allow_override=True)

    match = gdf[gdf["SUB_CATCHMENT_NAME"].str.upper() == CATCHMENT_NAME]
    if match.empty:
        candidates = sorted(
            n for n in gdf["SUB_CATCHMENT_NAME"].dropna().unique() if "ELIZABETH" in n.upper()
        )
        raise SystemExit(
            f"Could not find sub-catchment '{CATCHMENT_NAME}'. "
            f"Candidates containing 'ELIZABETH': {candidates}"
        )

    return match.to_crs(epsg=4326)


def polygon_to_esri_rings(geometry) -> list:
    """Convert a shapely (Multi)Polygon into Esri JSON rings, oriented per
    Esri convention (outer rings clockwise, holes counter-clockwise)."""
    polygons = geometry.geoms if geometry.geom_type == "MultiPolygon" else [geometry]
    rings = []
    for poly in polygons:
        oriented = orient(poly, sign=-1.0)
        rings.append([list(coord) for coord in oriented.exterior.coords])
        for interior in oriented.interiors:
            rings.append([list(coord) for coord in interior.coords])
    return rings


def query_overlay(service_url: str, catchment_geometry) -> dict:
    esri_geometry = {
        "rings": polygon_to_esri_rings(catchment_geometry),
        "spatialReference": {"wkid": 4326},
    }

    all_features = []
    offset = 0
    while True:
        response = requests.post(
            f"{service_url}/query",
            data={
                "f": "geojson",
                "geometry": json.dumps(esri_geometry),
                "geometryType": "esriGeometryPolygon",
                "spatialRel": "esriSpatialRelIntersects",
                "inSR": 4326,
                "outSR": 4326,
                "outFields": "*",
                "returnGeometry": "true",
                "resultOffset": offset,
            },
            timeout=60,
        )
        response.raise_for_status()
        payload = response.json()
        if "error" in payload:
            raise RuntimeError(f"ArcGIS query error for {service_url}: {payload['error']}")

        features = payload.get("features", [])
        all_features.extend(features)

        exceeded = payload.get("exceededTransferLimit") or payload.get("properties", {}).get(
            "exceededTransferLimit"
        )
        if not exceeded:
            break
        offset += len(features)

    return {"type": "FeatureCollection", "features": all_features}


def save_geojson(data: dict, path: Path) -> None:
    path.write_text(json.dumps(data, indent=2))
    print(f"Saved {len(data['features'])} feature(s) to {path}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--force-refresh",
        action="store_true",
        help="Re-download everything even if already cached in data/raw/",
    )
    args = parser.parse_args()

    catchments_path = download_catchments(args.force_refresh)
    catchment_gdf = load_elizabeth_street_catchment(catchments_path)
    catchment_geometry = unary_union(catchment_gdf.geometry)

    for layer_name, service_url in OVERLAY_LAYERS.items():
        overlay_path = RAW_CACHE_DIR / f"{layer_name}.geojson"
        if overlay_path.exists() and not args.force_refresh:
            print(f"Using cached {layer_name.upper()} file: {overlay_path}")
            continue
        print(f"Querying {layer_name.upper()}...")
        geojson = query_overlay(service_url, catchment_geometry)
        save_geojson(geojson, overlay_path)


if __name__ == "__main__":
    main()
