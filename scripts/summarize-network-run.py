#!/usr/bin/env python3
"""Check recorded default-network loss and recovery during one phone watcher run."""
import argparse
from datetime import datetime, timedelta
import json
from pathlib import Path
import re


def ts(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def summarize(watch, watch_events, observer, network_events, outage_code, min_offline_seconds=30):
    start = ts(watch["startedAt"])
    end = ts(watch["updatedAt"])
    if watch["status"] != "stopped" or end <= start:
        raise ValueError("Watcher must have a completed, positive-duration run")
    if observer.get("watchedRunStartedAt") != watch["startedAt"]:
        raise ValueError("Observer and watcher refer to different runs")
    events = [e for e in network_events if e["observerStartedAt"] == observer["startedAt"]]
    terminal = [e for e in events if e["type"] in ("observer_stopped", "observer_halted")]
    if len(terminal) != 1:
        raise ValueError("Expected exactly one observer terminal event")
    samples = [e for e in events if e["type"] == "sample" and e.get("watchedRunStartedAt") == watch["startedAt"]]
    if not samples:
        raise ValueError("No samples for the watcher run")
    times = [ts(e["time"]) for e in samples]
    gaps = [(b-a).total_seconds() for a,b in zip(times, times[1:])]
    elapsed = [e["elapsedMs"] for e in samples]
    terminal_time = ts(terminal[0]["time"])
    coverage_gaps = [(times[0]-start).total_seconds(), max(0, (end-times[-1]).total_seconds())] + gaps
    offline = lambda e: e["detail"].get("connected") is False and e["detail"].get("activeNetwork") is False
    online = lambda e: e["detail"].get("connected") is True and e["detail"].get("validated") is True
    episodes, current = [], []
    for e in samples:
        if offline(e):
            current.append(e)
        elif current:
            episodes.append(current)
            current = []
    if current:
        episodes.append(current)
    eligible = [group for group in episodes if len(group) >= 2 and (ts(group[-1]["time"])-ts(group[0]["time"])).total_seconds() >= min_offline_seconds]
    run_sends = [e for e in watch_events if e["type"] == "send_attempt" and start <= ts(e["time"]) <= end]
    outage_sends = [e for e in run_sends if e["detail"]["code"] == outage_code]
    checks = {
        "observer_stopped_with_watcher": observer["status"] == "stopped" and observer.get("stopReason") == "watcher_finished" and terminal[0]["type"] == "observer_stopped",
        "observer_covers_run": ts(observer["startedAt"]) <= start and end <= ts(terminal[0]["time"]) <= end + timedelta(seconds=10),
        "samples_chronological": all(g >= 0 for g in gaps) and all(b >= a for a,b in zip(elapsed, elapsed[1:])),
        "samples_within_run": all(start <= t <= terminal_time for t in times),
        "sample_coverage": max(coverage_gaps) <= 35,
        "usb_disconnected_all_samples": all(e["detail"].get("usbConnected") is False and e["detail"].get("usbConfigured") is False for e in samples),
        "one_sustained_offline_episode": len(eligible) == 1,
        "outage_code_sent_once": len(outage_sends) == 1,
    }
    details = None
    if len(eligible) == 1:
        group = eligible[0]
        first, last = ts(group[0]["time"]), ts(group[-1]["time"])
        restored = next((e for e in samples if ts(e["time"]) > last and online(e)), None)
        checks["online_before_outage"] = any(ts(e["time"]) < first and online(e) for e in samples)
        checks["validated_network_after_outage"] = restored is not None
        checks["no_sends_in_observed_offline_span"] = not any(first <= ts(e["time"]) <= last for e in run_sends)
        checks["outage_reply_after_last_offline_sample"] = len(outage_sends) == 1 and ts(outage_sends[0]["time"]) > last
        details = {"firstOfflineSampleAt":group[0]["time"], "lastOfflineSampleAt":group[-1]["time"], "observedOfflineSpanSeconds":round((last-first).total_seconds(),3), "offlineSamples":len(group), "firstValidatedSampleAfterOutageAt":restored["time"] if restored else None, "outageCodeSendAt":outage_sends[0]["time"] if len(outage_sends)==1 else None}
        if restored and len(outage_sends)==1:
            details["sendMinusFirstValidatedSampleSeconds"] = round((ts(outage_sends[0]["time"])-ts(restored["time"])).total_seconds(),3)
    return {"watcherStartedAt":watch["startedAt"], "observerStartedAt":observer["startedAt"], "networkSamples":len(samples), "maxSampleCoverageGapSeconds":round(max(coverage_gaps),3), "allOfflineEpisodes":len(episodes), "sustainedOfflineEpisodes":len(eligible), "outageCode":outage_code, "episode":details, "checks":checks, "passed":all(checks.values()), "scope":"Default-network samples only; exact switching time and message delivery require separate observations. The offline span is bounded by observed offline samples."}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ("watch-state", "watch-events", "network-state", "network-events"):
        parser.add_argument("--"+name,type=Path,required=True)
    parser.add_argument("--outage-code",required=True)
    parser.add_argument("--min-offline-seconds",type=float,default=30)
    parser.add_argument("--output")
    args=parser.parse_args()
    if not re.fullmatch(r"[0-9]{3}",args.outage_code) or args.min_offline_seconds < 0:
        parser.error("Use a three-digit code and a nonnegative offline duration")
    read_events=lambda p:[json.loads(line) for line in p.read_text().splitlines() if line]
    result=summarize(json.loads(args.watch_state.read_text()),read_events(args.watch_events),json.loads(args.network_state.read_text()),read_events(args.network_events),args.outage_code,args.min_offline_seconds)
    output=json.dumps(result,ensure_ascii=False,indent=2)+"\n"
    if args.output:
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]*\.json",args.output):
            parser.error("output must be a simple JSON filename")
        directory=Path(__file__).resolve().parents[1]/"artifacts"
        directory.mkdir(exist_ok=True)
        (directory/args.output).write_text(output)
    print(output,end="")
    raise SystemExit(0 if result["passed"] else 1)


if __name__ == "__main__":
    main()
