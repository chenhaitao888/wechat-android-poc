import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / ".local"


def load():
    cfg = json.loads((LOCAL / "settings.json").read_text())
    for key in ("review_key", "device_key", "biz_key", "hermes_key"):
        if len(cfg.get(key, "")) < 32:
            raise ValueError(f"Missing or weak {key}; run configure.py")
    return cfg
