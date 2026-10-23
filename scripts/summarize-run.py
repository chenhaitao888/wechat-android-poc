#!/usr/bin/env python3
"""Summarize one phone run without exporting chat text or device identifiers."""
import argparse
from collections import Counter
from datetime import datetime
import json
from pathlib import Path
import re


def timestamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def summarize(state, events):
    start = timestamp(state["startedAt"])
    starts = [i for i, e in enumerate(events) if e["type"] == "started" and 0 <= (timestamp(e["time"]) - start).total_seconds() < 2]
    if len(starts) != 1:
        raise ValueError("Cannot uniquely match state to the start event")
    begin = starts[0]
    end = next((i for i in range(begin + 1, len(events)) if events[i]["type"] == "started"), len(events))
    run = events[begin:end]
    terminal = [e for e in run if e["type"] in ("stopped", "halted")]
    if len(terminal) != 1:
        raise ValueError("Expected one terminal event; run may still be active")
    last = terminal[0]
    if abs((timestamp(last["time"]) - timestamp(state["updatedAt"])).total_seconds()) > 2:
        raise ValueError("Final state and terminal event disagree")
    samples = [{"time":run[0]["time"], "health":run[0]["detail"]["health"]}]
    samples += [{"time":e["time"], "health":e["detail"]} for e in run if e["type"] == "health"]
    elapsed = [s["health"]["elapsedSeconds"] for s in samples]
    gaps = [b-a for a,b in zip(elapsed, elapsed[1:])]
    duration = (timestamp(last["time"]) - start).total_seconds()
    coverage_gaps = [elapsed[0]] + gaps + [duration-elapsed[-1]]
    sends = Counter((e["detail"].get("messageId") or e["detail"]["code"]) for e in run if e["type"] == "send_attempt")
    bubbles = Counter((e["detail"].get("messageId") or e["detail"]["code"]) for e in run if e["type"] == "outgoing_bubble_observed")
    temperatures = [s["health"]["temperatureC"] for s in samples if s["health"].get("temperatureC") is not None]
    return {
        "startedAt":state["startedAt"], "stoppedAt":last["time"], "durationSeconds":round(duration, 3),
        "status":state["status"], "terminalEvent":last["type"],
        "stopReason":last["detail"].get("reason", state.get("stopReason")),
        "sendCounts":dict(sends), "observedBubbleCounts":dict(bubbles), "stateSendCount":state["sentThisRun"],
        "healthSamples":len(samples),
        "usbDisconnectedSamples":sum(s["health"].get("usbConnected") is False and s["health"].get("usbConfigured") is False for s in samples),
        "foregroundServiceSamples":sum(s["health"].get("foregroundServiceRunning") is True for s in samples),
        "batteryOptimizationExemptSamples":sum(s["health"].get("batteryOptimizationIgnored") is True for s in samples),
        "helperBatteryOptimizationExemptSamples":sum(s["health"].get("helperBatteryOptimizationIgnored") is True for s in samples),
        "touchExplorationEnabledSamples":sum(s["health"].get("touchExploration") is True for s in samples),
        "helperEnabledSamples":sum("local.wechat.accessibilityhelper/" in s["health"].get("enabledServices", "") for s in samples),
        "accessibilityStateKnownSamples":sum(isinstance(s["health"].get("enabledServices"), str) for s in samples),
        "nativeReaderEnabledSamples":sum("com.bjbyhd.screenreader_huawei/" in s["health"].get("enabledServices", "") for s in samples),
        "maxHealthCoverageGapSeconds":round(max(coverage_gaps), 3),
        "monotonicHealthSamples":all(g >= 0 for g in gaps),
        "maxTemperatureC":max(temperatures) if temperatures else None,
        "uncertainSends":sum(e["type"] == "uncertain" for e in run),
        "ambiguousBatches":sum(e["type"] == "batch_classified" and e["detail"]["decision"]["kind"] == "pause" for e in run),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--events", type=Path, required=True)
    expected_group = parser.add_mutually_exclusive_group(required=True)
    expected_group.add_argument("--expected-codes", nargs="+", help="Legacy three-digit test codes")
    expected_group.add_argument("--expected-replies", nargs="+", help="Test codes or local receipts such as text-1")
    parser.add_argument("--stop-reason", choices=["time_limit", "stop_file", "send_limit"], required=True)
    parser.add_argument("--min-seconds", type=float, default=0)
    parser.add_argument("--max-seconds", type=float)
    parser.add_argument("--max-health-gap-seconds", type=float, default=90)
    parser.add_argument("--fully-disconnected", action="store_true")
    parser.add_argument("--require-helper", action="store_true")
    parser.add_argument("--require-foreground-service", action="store_true")
    parser.add_argument("--require-battery-exemption", action="store_true")
    parser.add_argument("--require-helper-battery-exemption", action="store_true")
    parser.add_argument("--output", help="JSON filename written only under the local artifacts directory")
    args = parser.parse_args()
    expected_replies = args.expected_codes or args.expected_replies
    pattern = r"[0-9]{3}" if args.expected_codes else r"(?:[0-9]{3}|text-[1-9][0-9]*)"
    if not all(re.fullmatch(pattern, key) for key in expected_replies) or len(set(expected_replies)) != len(expected_replies):
        parser.error("expected replies must be distinct test codes or valid local receipt IDs")
    state = json.loads(args.state.read_text())
    events = [json.loads(line) for line in args.events.read_text().splitlines() if line]
    result = summarize(state, events)
    expected = {key:1 for key in expected_replies}
    checks = {
        "stopped_normally":result["status"] == "stopped" and result["terminalEvent"] == "stopped",
        "stop_reason":result["stopReason"] == args.stop_reason,
        "minimum_duration":result["durationSeconds"] >= args.min_seconds,
        "expected_single_sends":result["sendCounts"] == expected,
        "outgoing_bubbles_observed":result["observedBubbleCounts"] == expected,
        "state_count_matches":result["stateSendCount"] == len(expected_replies),
        "no_uncertain_send":result["uncertainSends"] == 0,
        "no_ambiguous_batch":result["ambiguousBatches"] == 0,
        "health_coverage":result["healthSamples"] >= 2 and result["monotonicHealthSamples"] and result["maxHealthCoverageGapSeconds"] <= args.max_health_gap_seconds,
    }
    if args.max_seconds is not None:
        checks["maximum_duration"] = result["durationSeconds"] <= args.max_seconds
    if args.fully_disconnected:
        checks["usb_disconnected_all_samples"] = result["usbDisconnectedSamples"] == result["healthSamples"]
    if args.require_helper:
        checks["helper_all_samples"] = result["helperEnabledSamples"] == result["healthSamples"]
        checks["touch_mode_all_samples"] = result["touchExplorationEnabledSamples"] == result["healthSamples"]
        checks["native_reader_off"] = result["accessibilityStateKnownSamples"] == result["healthSamples"] and result["nativeReaderEnabledSamples"] == 0
    if args.require_foreground_service:
        checks["foreground_service_all_samples"] = result["foregroundServiceSamples"] == result["healthSamples"]
    if args.require_battery_exemption:
        checks["battery_exemption_all_samples"] = result["batteryOptimizationExemptSamples"] == result["healthSamples"]
    if args.require_helper_battery_exemption:
        checks["helper_battery_exemption_all_samples"] = result["helperBatteryOptimizationExemptSamples"] == result["healthSamples"]
    result["checks"] = checks
    result["passed"] = all(checks.values())
    result["deliveryConfirmation"] = "Requires separate recipient confirmation; outgoing bubbles alone do not prove delivery."
    output = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]*\.json", args.output):
            parser.error("output must be a simple JSON filename")
        artifacts = Path(__file__).resolve().parents[1] / "artifacts"
        artifacts.mkdir(exist_ok=True)
        (artifacts / args.output).write_text(output)
    print(output, end="")
    raise SystemExit(0 if result["passed"] else 1)


if __name__ == "__main__":
    main()
