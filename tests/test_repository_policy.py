import importlib.util
import shutil
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "policy", ROOT / "scripts/repository-policy.py"
)
POLICY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(POLICY)


class PolicyTests(unittest.TestCase):
    def rejected(self, old, new):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            shutil.copytree(ROOT / ".forgejo", root / ".forgejo")
            shutil.copyfile(ROOT / "CODEOWNERS", root / "CODEOWNERS")
            shutil.copyfile(ROOT / "package.json", root / "package.json")
            path = root / ".forgejo/workflows/ci.yml"
            text = path.read_text()
            self.assertIn(old, text)
            path.write_text(text.replace(old, new, 1))
            with self.assertRaises(POLICY.PolicyError):
                POLICY.validate(root)

    def test_current_repository(self):
        POLICY.validate(ROOT)

    def test_push_is_rejected(self):
        self.rejected("  pull_request:\n", "  push:\n")

    def test_non_current_head_is_rejected(self):
        self.rejected("${{ github.event.pull_request.head.sha }}", "main")

    def test_credentials_are_rejected(self):
        self.rejected("persist-credentials: false", "persist-credentials: true")

    def test_unpinned_checkout_is_rejected(self):
        self.rejected("@d23441a48e516b6c34aea4fa41551a30e30af803", "@v6")

    def test_secret_reference_is_rejected(self):
        self.rejected("set -euo pipefail", "echo '${{ secrets.PUBLISH_TOKEN }}'")

    def test_write_permission_is_rejected(self):
        self.rejected("contents: read", "contents: write")
