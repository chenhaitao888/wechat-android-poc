"""CLI evidence checks: every sampled runtime condition must be explicitly true."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
HEALTH = {
    "elapsedSeconds": 0, "usbConnected": False, "usbConfigured": False,
    "touchExploration": True, "foregroundServiceRunning": True,
    "batteryOptimizationIgnored": True,
    "enabledServices": "org.autojs.autoxjs.v7/Service:local.wechat.accessibilityhelper/Service",
}


def fixture():
    state = {"startedAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:01:02.000Z",
             "status": "stopped", "sentThisRun": 1, "stopReason": "time_limit"}
    events = [
        {"time": state["startedAt"], "type": "started", "detail": {"health": copy.deepcopy(HEALTH)}},
        {"time": "2026-01-01T00:00:20.000Z", "type": "send_attempt", "detail": {"code": "034"}},
        {"time": "2026-01-01T00:00:22.000Z", "type": "outgoing_bubble_observed", "detail": {"code": "034"}},
        {"time": "2026-01-01T00:01:00.000Z", "type": "health", "detail": {**HEALTH, "elapsedSeconds": 60}},
        {"time": state["updatedAt"], "type": "stopped", "detail": {"reason": "time_limit"}},
    ]
    return state, events


def check(state, events):
    with tempfile.TemporaryDirectory() as directory:
        base = Path(directory)
        (base / "state.json").write_text(json.dumps(state))
        (base / "events.jsonl").write_text("\n".join(json.dumps(e) for e in events))
        run = subprocess.run([sys.executable, str(ROOT / "scripts/summarize-run.py"),
            "--state", str(base / "state.json"), "--events", str(base / "events.jsonl"),
            "--expected-codes", "034", "--stop-reason", "time_limit", "--min-seconds", "60",
            "--max-seconds", "65", "--fully-disconnected", "--require-helper",
            "--require-foreground-service", "--require-battery-exemption"],
            text=True, capture_output=True, check=False)
        return run.returncode, json.loads(run.stdout)


class RunSummaryTests(unittest.TestCase):
    def test_all_runtime_samples_verified(self):
        status, result = check(*fixture())
        self.assertEqual(status, 0)
        self.assertTrue(result["passed"])
        self.assertEqual(result["foregroundServiceSamples"], 2)
        self.assertEqual(result["batteryOptimizationExemptSamples"], 2)

    def test_one_missing_false_or_nonboolean_sample_cannot_pass(self):
        for field, key in [("foregroundServiceRunning", "foreground_service_all_samples"),
                           ("batteryOptimizationIgnored", "battery_exemption_all_samples")]:
            for value in [None, False, "true"]:
                with self.subTest(field=field, value=value):
                    state, events = fixture()
                    if value is None:
                        events[3]["detail"].pop(field)
                    else:
                        events[3]["detail"][field] = value
                    status, result = check(state, events)
                    self.assertEqual(status, 1)
                    self.assertFalse(result["checks"][key])

    def test_long_pause_cannot_pass_with_only_start_and_end_samples(self):
        state, events = fixture()
        state["updatedAt"] = "2026-01-01T00:05:02.000Z"
        events[-1]["time"] = state["updatedAt"]
        status, result = check(state, events)
        self.assertEqual(status, 1)
        self.assertFalse(result["checks"]["health_coverage"])


if __name__ == "__main__":
    unittest.main()
