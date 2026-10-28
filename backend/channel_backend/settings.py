import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCAL = Path(os.environ.get("CHANNEL_DATA_DIR", str(ROOT / ".local"))).expanduser().resolve()


def load():
    cfg = json.loads((LOCAL / "settings.json").read_text())
    for key in ("review_key", "device_key", "biz_key", "hermes_key"):
        if len(cfg.get(key, "")) < 32:
            raise ValueError(f"Missing or weak {key}; run configure.py")
    return cfg
