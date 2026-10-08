"""Offline regression tests for the attributed official flood-data importer.

Run from the repository root:
    python3 -m unittest discover -s scripts -p 'test_fetch_official_flood_data.py' -v

Every HTTP entry point is mocked: these tests never query the real service.
"""

import copy
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

import fetch_official_flood_data as importer


OUTER = [
    [144.960, -37.810], [144.965, -37.810],
    [144.965, -37.815], [144.960, -37.815], [144.960, -37.810],
]
HOLE = [
    [144.961, -37.811], [144.961, -37.812],
    [144.962, -37.812], [144.962, -37.811], [144.961, -37.811],
]
SMALL = [
    [144.9601, -37.8101], [144.9602, -37.8101],
    [144.9602, -37.8102], [144.9601, -37.8101],
]


def epoch_milliseconds(date):
    return int(datetime.fromisoformat(date).replace(tzinfo=timezone.utc).timestamp() * 1000)


def feature(spec, object_id, coordinates=None, geometry_type="Polygon"):
    return {
        "type": "Feature",
        "properties": {
            "OBJECTID": object_id,
            "STUDY_NAME": importer.STUDY,
            "FLOOD_EVENT": "1PCT",
            "MODELLING_SCENARIO": spec["scenario"],
            "STUDY_DATE": epoch_milliseconds(spec["study_date"]),
            "UPSTREAM_LIMIT": "Lytton Street" if spec["id"] == "baseline" else "THERRY STREET MELBOURNE",
            "DOWNSTREAM_LIMIT": "Yarra River",
            "STUDY_BY": "Water Technology",
            "ACCEPTED_ON": None,
            "COMMENTS": "Base Case." if spec["id"] == "baseline" else "PLANNING SCHEME AMENDMENT",
        },
        "geometry": {
            "type": geometry_type,
            "coordinates": copy.deepcopy(coordinates if coordinates is not None else [OUTER]),
        },
    }


def collection(spec, ids):
    return {"type": "FeatureCollection", "features": [feature(spec, object_id) for object_id in ids]}


class OfflineTestCase(unittest.TestCase):
    def setUp(self):
        self.network_guard = patch.object(
            importer.urllib.request, "urlopen",
            side_effect=AssertionError("Real network access is disabled in these tests"),
        )
        self.network_guard.start()
        self.addCleanup(self.network_guard.stop)


class DateTests(OfflineTestCase):
    def test_actual_source_study_dates_in_utc(self):
        self.assertEqual(importer.iso_date(1597276800000), "2020-08-13")
        self.assertEqual(importer.iso_date(1504137600000), "2017-08-31")

    def test_null_date_remains_unknown(self):
        self.assertIsNone(importer.iso_date(None))


class GeometryTests(OfflineTestCase):
    def test_polygon_keeps_holes_unchanged(self):
        geometry = {"type": "Polygon", "coordinates": copy.deepcopy([OUTER, HOLE])}
        before = copy.deepcopy(geometry)
        self.assertEqual(importer.validate_geometry(geometry), 10)
        self.assertEqual(geometry, before)

    def test_multipolygon_keeps_small_polygon_and_holes(self):
        geometry = {"type": "MultiPolygon", "coordinates": copy.deepcopy([[OUTER, HOLE], [SMALL]])}
        before = copy.deepcopy(geometry)
        self.assertEqual(importer.validate_geometry(geometry), 14)
        self.assertEqual(geometry, before)

    def test_rejects_missing_empty_and_non_polygon_geometry(self):
        for geometry in (
            None, {}, {"type": "Point", "coordinates": OUTER[0]},
            {"type": "Polygon", "coordinates": []},
            {"type": "MultiPolygon", "coordinates": []},
            {"type": "MultiPolygon", "coordinates": [[]]},
        ):
            with self.subTest(geometry=geometry), self.assertRaises(ValueError):
                importer.validate_geometry(geometry)

    def test_rejects_short_or_unclosed_rings(self):
        for ring in (OUTER[:3], OUTER[:-1], []):
            with self.subTest(ring=ring), self.assertRaises(ValueError):
                importer.validate_geometry({"type": "Polygon", "coordinates": [ring]})

    def test_rejects_nonfinite_3d_and_out_of_range_coordinates(self):
        for point in (
            [float("nan"), -37.81], [float("inf"), -37.81],
            [144.96, float("-inf")], [144.96, -37.81, 0],
            [181, -37.81], [-181, -37.81], [144.96, 91],
            [144.96, -91], ["144.96", -37.81],
        ):
            ring = copy.deepcopy(OUTER)
            ring[1] = point
            with self.subTest(point=point), self.assertRaises(ValueError):
                importer.validate_geometry({"type": "Polygon", "coordinates": [ring]})

    def test_rejects_booleans_in_either_coordinate_position(self):
        for point in ([True, -37.81], [False, -37.81], [144.96, True], [144.96, False]):
            ring = copy.deepcopy(OUTER)
            ring[1] = point
            with self.subTest(point=point), self.assertRaisesRegex(ValueError, "finite 2D"):
                importer.validate_geometry({"type": "Polygon", "coordinates": [ring]})


class CollectionTests(OfflineTestCase):
    def setUp(self):
        super().setUp()
        self.baseline = importer.SPECS[0]
        self.future = importer.SPECS[1]

    def test_accepts_baseline_and_three_separate_future_features(self):
        self.assertEqual(importer.validate_collection(collection(self.baseline, [596]), self.baseline, [596]), 5)
        self.assertEqual(importer.validate_collection(collection(self.future, [9, 7, 8]), self.future, [7, 8, 9]), 15)

    def test_rejects_wrong_collection_type_or_record_count(self):
        cases = [
            {"type": "Feature", "features": []},
            {"type": "FeatureCollection", "features": []},
            collection(self.baseline, [596, 597]),
        ]
        for payload in cases:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                importer.validate_collection(payload, self.baseline, [596])

    def test_rejects_collection_members_that_are_not_features(self):
        missing_type = feature(self.baseline, 596)
        del missing_type["type"]
        wrong_type = feature(self.baseline, 596)
        wrong_type["type"] = "Point"
        for member in (missing_type, wrong_type, None, [], "Feature"):
            payload = {"type": "FeatureCollection", "features": [member]}
            with self.subTest(member=member), self.assertRaisesRegex(ValueError, "Feature members"):
                importer.validate_collection(payload, self.baseline, [596])

    def test_rejects_missing_wrong_or_duplicate_ids(self):
        for ids in ([7, 7, 9], [7, 8, 10], [7, 8, None]):
            with self.subTest(ids=ids), self.assertRaisesRegex(ValueError, "object IDs"):
                importer.validate_collection(collection(self.future, ids), self.future, [7, 8, 9])

    def test_rejects_wrong_study_aep_or_scenario(self):
        replacements = {
            "STUDY_NAME": "ELIZABETH ST M.D. (COBURG)",
            "FLOOD_EVENT": "5PCT",
            "MODELLING_SCENARIO": "Yr 2100, RCP 8.5",
        }
        for field, value in replacements.items():
            payload = collection(self.baseline, [596])
            payload["features"][0]["properties"][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "study/event/scenario"):
                importer.validate_collection(payload, self.baseline, [596])

    def test_rejects_changed_or_missing_study_date(self):
        for date in (epoch_milliseconds("2021-08-13"), None):
            payload = collection(self.baseline, [596])
            payload["features"][0]["properties"]["STUDY_DATE"] = date
            with self.subTest(date=date), self.assertRaisesRegex(ValueError, "Study date changed"):
                importer.validate_collection(payload, self.baseline, [596])


class ResponseTests(OfflineTestCase):
    def request_payload(self, payload):
        stream = io.BytesIO(json.dumps(payload).encode())
        with patch.object(importer.urllib.request, "urlopen", return_value=stream):
            return importer.request_json("https://example.test/query")

    def test_accepts_valid_dictionary(self):
        payload = {"objectIds": [596]}
        self.assertEqual(self.request_payload(payload), payload)

    def test_rejects_arcgis_error_and_nonobject_json(self):
        for payload in ({"error": {"code": 400, "message": "Invalid query"}}, [], None):
            with self.subTest(payload=payload), self.assertRaisesRegex(ValueError, "Invalid ArcGIS response"):
                self.request_payload(payload)

    def test_rejects_both_transfer_limit_locations(self):
        for payload in (
            {"exceededTransferLimit": True},
            {"properties": {"exceededTransferLimit": True}},
        ):
            with self.subTest(payload=payload), self.assertRaisesRegex(ValueError, "Truncated"):
                self.request_payload(payload)

    def test_accepts_explicit_false_transfer_limit(self):
        payload = {"type": "FeatureCollection", "features": [], "properties": {"exceededTransferLimit": False}}
        self.assertEqual(self.request_payload(payload), payload)

    def test_rejects_invalid_json(self):
        with patch.object(importer.urllib.request, "urlopen", return_value=io.BytesIO(b"not JSON")):
            with self.assertRaises(json.JSONDecodeError):
                importer.request_json("https://example.test/query")


class SnapshotTests(OfflineTestCase):
    def test_fetch_preserves_original_geometry_properties_and_hash(self):
        spec = importer.SPECS[1]
        payload = collection(spec, [7, 8, 9])
        payload["features"][0]["geometry"]["coordinates"].append(copy.deepcopy(HOLE))
        payload["features"][1]["geometry"]["coordinates"] = [copy.deepcopy(SMALL)]
        original = copy.deepcopy(payload)
        with patch.object(importer, "request_json", side_effect=[{"objectIds": [9, 7, 8]}, payload]) as request:
            content, metadata = importer.fetch_snapshot(spec)
        self.assertEqual(json.loads(content), original)
        self.assertEqual(payload, original)
        self.assertEqual(metadata["object_ids"], [7, 8, 9])
        self.assertEqual(metadata["feature_count"], 3)
        self.assertEqual(metadata["coordinate_count"], 19)
        self.assertEqual(metadata["study_date"], "2017-08-31")
        self.assertFalse(metadata["synthetic"])
        self.assertEqual(metadata["sha256"], hashlib.sha256(content).hexdigest())
        first = parse_qs(urlparse(request.call_args_list[0].args[0]).query)
        second = parse_qs(urlparse(request.call_args_list[1].args[0]).query)
        self.assertEqual(first["returnIdsOnly"], ["true"])
        self.assertIn(importer.STUDY, first["where"][0])
        self.assertIn("FLOOD_EVENT='1PCT'", first["where"][0])
        self.assertIn(spec["scenario"], first["where"][0])
        self.assertEqual(second["objectIds"], ["7,8,9"])
        for key, value in {"outSR": "4326", "returnZ": "false", "returnM": "false", "f": "geojson"}.items():
            self.assertEqual(second[key], [value])

    def test_wrong_source_count_stops_before_geometry_request(self):
        for ids in ([], [7, 8], [7, 8, 9, 10]):
            with self.subTest(ids=ids):
                with patch.object(importer, "request_json", return_value={"objectIds": ids}) as request:
                    with self.assertRaisesRegex(ValueError, "Source count changed"):
                        importer.fetch_snapshot(importer.SPECS[1])
                    request.assert_called_once()

    def test_validation_failure_does_not_replace_existing_files(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            existing = output / importer.SPECS[0]["filename"]
            existing.write_bytes(b"original snapshot")
            baseline_content = json.dumps(collection(importer.SPECS[0], [596])).encode()
            with patch.object(sys, "argv", ["fetch_official_flood_data.py", "--output-dir", directory]):
                with patch.object(importer, "fetch_snapshot", side_effect=[(baseline_content, {}), ValueError("bad future data")]):
                    with self.assertRaisesRegex(ValueError, "bad future data"):
                        importer.main()
            self.assertEqual(existing.read_bytes(), b"original snapshot")
            self.assertEqual(list(output.iterdir()), [existing])


if __name__ == "__main__":
    unittest.main()
