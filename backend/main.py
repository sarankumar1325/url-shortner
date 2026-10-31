"""Vercel entrypoint for the src-layout backend package."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from backend.main import app  # noqa: E402

__all__ = ["app"]
