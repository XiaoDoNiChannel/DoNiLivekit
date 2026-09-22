import importlib
import json
import tempfile
import unittest
from pathlib import Path
from urllib.parse import quote
from unittest.mock import patch

from fastapi.testclient import TestClient

backend = importlib.import_module("server.app")
updates = importlib.import_module("server.api.updates")


class UpdateApiTests(unittest.TestCase):
    def test_update_manifest_no_update_and_signed_download(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db_path = root / "rooms.db"
            bundle = root / "DoNiChannel_0.2.0_x64-setup.nsis.zip"
            bundle.write_bytes(b"signed-bundle-placeholder")
            (root / "latest.json").write_text(
                json.dumps(
                    {
                        "version": "0.2.0",
                        "notes": "P1",
                        "pub_date": "2026-09-20T00:00:00Z",
                        "platforms": {
                            "windows-x86_64": {
                                "url": f"https://github.invalid/{bundle.name}",
                                "signature": "signed-value",
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            with (
                patch.object(updates, "DOWNLOADS_DIR", root),
                patch.object(updates, "UPDATE_BASE_URL", ""),
                patch.object(backend, "DB_PATH", db_path),
                TestClient(backend.app) as client,
            ):
                no_update = client.get("/api/update/windows/x86_64/0.2.0")
                available = client.get("/api/update/windows/x86_64/0.1.0")
                downloaded = client.get(f"/downloads/{bundle.name}")

            self.assertEqual(no_update.status_code, 204)
            self.assertEqual(available.status_code, 200)
            body = available.json()
            self.assertEqual(body["version"], "0.2.0")
            self.assertEqual(body["signature"], "signed-value")
            self.assertTrue(body["url"].endswith(f"/downloads/{bundle.name}"))
            self.assertEqual(downloaded.content, b"signed-bundle-placeholder")

    def test_percent_encoded_unicode_artifact_name_is_resolved_locally(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db_path = root / "rooms.db"
            bundle = root / "小豆泥电竞_0.3.0_x64-setup.nsis.zip"
            bundle.write_bytes(b"unicode-name-bundle")
            encoded_name = quote(bundle.name)
            (root / "latest.json").write_text(
                json.dumps(
                    {
                        "version": "0.3.0",
                        "platforms": {
                            "windows-x86_64": {
                                "url": f"https://github.invalid/{encoded_name}",
                                "signature": "signed-value",
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            with (
                patch.object(updates, "DOWNLOADS_DIR", root),
                patch.object(updates, "UPDATE_BASE_URL", ""),
                patch.object(backend, "DB_PATH", db_path),
                TestClient(backend.app) as client,
            ):
                available = client.get("/api/update/windows/x86_64/0.2.0")
                downloaded = client.get(f"/downloads/{bundle.name}")

            self.assertEqual(available.status_code, 200)
            self.assertTrue(available.json()["url"].endswith(f"/downloads/{bundle.name}"))
            self.assertEqual(downloaded.content, b"unicode-name-bundle")


if __name__ == "__main__":
    unittest.main()
