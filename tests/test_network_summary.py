"""Synthetic log checks: incomplete or contradictory evidence must not pass."""
import copy
from datetime import datetime, timedelta, timezone
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location(
    "network_summary", Path(__file__).resolve().parents[1] / "scripts/summarize-network-run.py"
)
SUMMARY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SUMMARY)
EPOCH = datetime(2026, 10, 22, tzinfo=timezone.utc)


def at(seconds):
    return (EPOCH + timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z")


def fixture():
    watch = {"startedAt": at(0), "updatedAt": at(180), "status": "stopped"}
    observer = {"startedAt": at(-10), "watchedRunStartedAt": at(0),
                "status": "stopped", "stopReason": "watcher_finished"}

    def event(seconds, kind, detail, run=at(0)):
        return {"time": at(seconds), "type": kind, "elapsedMs": (seconds+10)*1000,
                "observerStartedAt": at(-10), "watchedRunStartedAt": run, "detail": detail}

    # Pre-run USB-connected samples are deliberately excluded from the run.
    events = [event(-8, "sample", {"usbConnected": True}, run=None)]
    for seconds in range(0, 181, 30):
        online = not (30 <= seconds <= 90)
        events.append(event(seconds, "sample", {
            "connected": online, "activeNetwork": online, "validated": online,
            "usbConnected": False, "usbConfigured": False,
        }))
    events.append(event(182, "observer_stopped", {"reason": "watcher_finished"}))
    sends = [{"time": at(125), "type": "send_attempt", "detail": {"code": "025"}}]
    return watch, sends, observer, events


class NetworkSummaryTests(unittest.TestCase):
    def summarize(self, data):
        return SUMMARY.summarize(*data, outage_code="025")

    def test_complete_recovery_passes_and_ignores_pre_run_usb(self):
        result = self.summarize(fixture())
        self.assertTrue(result["passed"], result["checks"])
        self.assertEqual(result["networkSamples"], 7)
        self.assertEqual(result["episode"]["observedOfflineSpanSeconds"], 60)
        self.assertEqual(result["episode"]["sendMinusFirstValidatedSampleSeconds"], 5)

    def test_no_offline_evidence_fails(self):
        data = fixture()
        for event in data[3][1:-1]:
            event["detail"].update(connected=True, activeNetwork=True, validated=True)
        result = self.summarize(data)
        self.assertFalse(result["passed"])
        self.assertFalse(result["checks"]["one_sustained_offline_episode"])

    def test_send_while_observed_offline_fails(self):
        data = fixture()
        data[1][0]["time"] = at(60)
        result = self.summarize(data)
        self.assertFalse(result["checks"]["no_sends_in_observed_offline_span"])
        self.assertFalse(result["checks"]["outage_reply_after_last_offline_sample"])

    def test_duplicate_send_and_usb_reconnection_fail(self):
        data = fixture()
        data[1].append(copy.deepcopy(data[1][0]))
        data[3][2]["detail"]["usbConnected"] = True
        result = self.summarize(data)
        self.assertFalse(result["checks"]["outage_code_sent_once"])
        self.assertFalse(result["checks"]["usb_disconnected_all_samples"])

    def test_missing_samples_fail_coverage(self):
        data = fixture()
        del data[3][5:7]  # Leave a 90-second gap after the offline interval.
        result = self.summarize(data)
        self.assertFalse(result["checks"]["sample_coverage"])

    def test_wrong_run_or_missing_terminal_are_rejected(self):
        data = fixture()
        data[2]["watchedRunStartedAt"] = at(1)
        with self.assertRaisesRegex(ValueError, "different runs"):
            self.summarize(data)
        data = fixture()
        data[3].pop()
        with self.assertRaisesRegex(ValueError, "terminal event"):
            self.summarize(data)

    def test_observer_timeout_does_not_count_as_complete_run(self):
        data = fixture()
        data[2]["stopReason"] = "observer_time_limit"
        self.assertFalse(self.summarize(data)["checks"]["observer_stopped_with_watcher"])

    def test_out_of_run_or_reordered_samples_fail(self):
        data = fixture()
        data[3][1]["time"] = at(-1)
        self.assertFalse(self.summarize(data)["checks"]["samples_within_run"])
        data = fixture()
        data[3][2], data[3][3] = data[3][3], data[3][2]
        self.assertFalse(self.summarize(data)["checks"]["samples_chronological"])


if __name__ == "__main__":
    unittest.main()
