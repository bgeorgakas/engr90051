#!/usr/bin/env python3
"""Fetch small, attributed Melbourne Water model snapshots for this prototype.

Only Elizabeth Street records are requested. No simplification, erosion,
buffering or synthetic geometry is applied. No third-party Python packages
are required. Public access does not establish redistribution permission.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import urllib.parse
import urllib.request

SOURCE = "https://spatial.planning.vic.gov.au/server/rest/services/planning_flood_control/MapServer/11"
STUDY = "ELIZABETH ST DRAIN (CITY)"
FIELDS = [
    "OBJECTID", "STUDY_NAME", "UPSTREAM_LIMIT", "DOWNSTREAM_LIMIT", "STUDY_BY",
    "STUDY_DATE", "ACCEPTED_ON", "ACCEPTED_BY", "SURVEY_SOURCES",
    "CALCULATION_METHOD", "FLOOD_TYPE", "FLOOD_EVENT", "MODELLING_SCENARIO",
    "COMMENTS", "MERGE_SRC",
]
SPECS = [
    {"id": "baseline", "scenario": "Existing Condition", "expected_count": 1,
     "label": "Baseline 1% AEP — 2020 study", "study_date": "2020-08-13",
     "filename": "flood_extent_baseline.geojson"},
    {"id": "future_2100", "scenario": "Yr 2100, RCP 8.5", "expected_count": 3,
     "label": "2100 RCP 8.5, 1% AEP — 2017 study", "study_date": "2017-08-31",
     "filename": "flood_extent_2100.geojson"},
]


def query_url(params):
    return SOURCE + "/query?" + urllib.parse.urlencode(params)


def request_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "ENGR90051-research-prototype/1.0"})
    with urllib.request.urlopen(req, timeout=90) as response:
        payload = json.load(response)
    if not isinstance(payload, dict) or "error" in payload:
        raise ValueError(f"Invalid ArcGIS response: {payload.get('error') if isinstance(payload, dict) else type(payload)}")
    if payload.get("exceededTransferLimit") or payload.get("properties", {}).get("exceededTransferLimit"):
        raise ValueError("Truncated response; refusing to save an incomplete snapshot")
    return payload


def iso_date(value):
    if value is None:
        return None
    return datetime.fromtimestamp(value / 1000, timezone.utc).date().isoformat()


def validate_geometry(geometry):
    """Structural/coordinate validation, not a claim of topological validity."""
    if not geometry or geometry.get("type") not in ("Polygon", "MultiPolygon"):
        raise ValueError("Expected Polygon or MultiPolygon geometry")
    coords = geometry.get("coordinates", [])
    polygons = [coords] if geometry["type"] == "Polygon" else coords
    if not polygons:
        raise ValueError("Empty geometry")
    points = 0
    for polygon in polygons:
        if not polygon:
            raise ValueError("Empty polygon")
        for ring in polygon:
            if len(ring) < 4 or ring[0] != ring[-1]:
                raise ValueError("Invalid or unclosed polygon ring")
            for point in ring:
                if len(point) != 2 or not all(
                    isinstance(v, (float, int)) and not isinstance(v, bool) and math.isfinite(v)
                    for v in point
                ):
                    raise ValueError("Expected finite 2D coordinates")
                if not (-180 <= point[0] <= 180 and -90 <= point[1] <= 90):
                    raise ValueError("Coordinates are not WGS84 longitude/latitude")
                points += 1
    return points


def validate_collection(payload, spec, expected_ids):
    if payload.get("type") != "FeatureCollection":
        raise ValueError("Expected GeoJSON FeatureCollection")
    features = payload.get("features", [])
    if len(features) != spec["expected_count"]:
        raise ValueError(f"Unexpected {spec['id']} record count: {len(features)}; review source changes")
    ids = []
    point_count = 0
    for feature in features:
        if not isinstance(feature, dict) or feature.get("type") != "Feature":
            raise ValueError("Expected GeoJSON Feature members")
        props = feature.get("properties", {})
        if (props.get("STUDY_NAME"), props.get("FLOOD_EVENT"), props.get("MODELLING_SCENARIO")) != (STUDY, "1PCT", spec["scenario"]):
            raise ValueError("Record does not match the requested study/event/scenario")
        if iso_date(props.get("STUDY_DATE")) != spec["study_date"]:
            raise ValueError("Study date changed; review labels before refreshing data")
        ids.append(props.get("OBJECTID"))
        point_count += validate_geometry(feature.get("geometry"))
    if len(set(ids)) != len(ids) or set(ids) != set(expected_ids):
        raise ValueError("Missing, duplicate or unexpected object IDs")
    return point_count


def fetch_snapshot(spec):
    where = f"STUDY_NAME='{STUDY}' AND FLOOD_EVENT='1PCT' AND MODELLING_SCENARIO='{spec['scenario']}'"
    id_payload = request_json(query_url({"where": where, "returnIdsOnly": "true", "f": "json"}))
    ids = id_payload.get("objectIds", [])
    if not ids or len(ids) != spec["expected_count"]:
        raise ValueError(f"Source count changed for {spec['id']}; review before importing: {ids}")
    params = {
        "where": where, "objectIds": ",".join(str(i) for i in sorted(ids)),
        "outFields": ",".join(FIELDS), "returnGeometry": "true", "returnZ": "false",
        "returnM": "false", "outSR": "4326", "f": "geojson",
    }
    url = query_url(params)
    payload = request_json(url)
    point_count = validate_collection(payload, spec, ids)
    content = (json.dumps(payload, separators=(",", ":"), ensure_ascii=False, allow_nan=False) + "\n").encode()
    features = payload["features"]
    record_params = {"where": where, "outFields": ",".join(FIELDS), "returnGeometry": "false", "f": "pjson"}
    metadata = {
        "id": spec["id"], "label": spec["label"],
        "file": "data/official/" + spec["filename"],
        "source_url": SOURCE, "download_url": url, "records_url": query_url(record_params),
        "study_name": STUDY, "aep": "1PCT", "modelling_scenario": spec["scenario"],
        "study_date": spec["study_date"], "synthetic": False,
        "feature_count": len(features), "object_ids": sorted(ids), "coordinate_count": point_count,
        "upstream_limits": sorted({f["properties"]["UPSTREAM_LIMIT"] for f in features if f["properties"].get("UPSTREAM_LIMIT")}),
        "downstream_limits": sorted({f["properties"]["DOWNSTREAM_LIMIT"] for f in features if f["properties"].get("DOWNSTREAM_LIMIT")}),
        "sha256": hashlib.sha256(content).hexdigest(),
    }
    return content, metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "official")
    args = parser.parse_args()
    snapshots = [(spec, *fetch_snapshot(spec)) for spec in SPECS]
    item_info = request_json(SOURCE + "/iteminfo?f=pjson")
    manifest = {
        "schema_version": 1,
        "publisher": "Melbourne Water Corporation",
        "title": item_info.get("title", "Melbourne Water Flood Extent"),
        "retrieved_at_utc": datetime.now(timezone.utc).isoformat(),
        "source_url": SOURCE, "metadata_url": SOURCE + "/iteminfo",
        "source_license_info": item_info.get("licenseInfo") or None,
        "reuse_status": "Permission for public redistribution has not been confirmed. Check source terms before publishing these snapshots.",
        "geometry_processing": "Original server-projected WGS84 polygon coordinates retained, including holes and small polygons; no buffering or simplification.",
        "limitations": [
            "Modelled flood extents, not live conditions, warnings, flood depth or address risk ratings.",
            "Outside a displayed polygon does not mean safe or prove that the location was assessed.",
            "Baseline and future layers have different study dates and recorded upstream limits; not a like-for-like time comparison.",
            "AEP means annual exceedance probability, not an event that happens only once every 100 years.",
        ],
        "datasets": [metadata for _, _, metadata in snapshots],
    }
    # Validate everything before replacing any existing snapshots.
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for spec, content, metadata in snapshots:
        path = args.output_dir / spec["filename"]
        pending = path.with_suffix(path.suffix + ".tmp")
        pending.write_bytes(content)
        pending.replace(path)
        print(f"{path.name}: {metadata['feature_count']} features, {metadata['coordinate_count']} coordinates")
    manifest_path = args.output_dir / "manifest.json"
    pending = manifest_path.with_suffix(".json.tmp")
    pending.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    pending.replace(manifest_path)
    print(f"Saved source manifest to {manifest_path}")


if __name__ == "__main__":
    main()
