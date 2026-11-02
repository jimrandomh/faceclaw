#!/usr/bin/env python3
"""Inspect timestamps in an app-private ring-frames.jsonl export (read-only).

Prints clock metadata, never measurement values. A latest timestamp may be old;
its age is not by itself a clock measurement. Repeated *future* HR timestamps
tracking receipt time are stronger evidence. All output instants are UTC.
"""

import argparse
import datetime
import json
import struct


def utc(seconds):
    return datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc).isoformat()


def audit(record):
    raw = bytes.fromhex(record["raw"])
    if len(raw) < 24 or raw[5:8] != b"\x64\x02\x64" or raw[10] != 2 or raw[12] != 1:
        return None
    if int.from_bytes(raw[13:15], "little") != len(raw) - 5:
        return None
    command = raw[11]
    metric = {1: "heart_rate", 2: "spo2", 4: "hrv", 5: "steps"}.get(command)
    if metric is None:
        return None
    payload = raw[15:]
    count, offset, anchor = struct.unpack_from("<BhI", payload, 2)
    width = 2 if command == 4 else 1
    stride = 7 if command == 5 else 1 + 3 * width
    header = len(payload) - count * stride
    if header not in ((9,) if command == 5 else (9, 13 + width)):
        return None
    received = record["receivedAtMs"] / 1000
    result = {
        "received_utc": utc(received),
        "metric": metric,
        "timezone_minutes": offset,
        "anchor_utc": utc(anchor),
        "anchor_local_seconds_after_midnight": (anchor + offset * 60) % 86400,
        "bucket_indices": list(payload[header::stride]),
    }
    if command != 5 and header != 9:
        latest = struct.unpack_from("<I", payload, 9)[0]
        result["latest_utc"] = utc(latest)
        result["latest_minus_received_seconds"] = round(latest - received, 3)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("journal")
    args = parser.parse_args()
    with open(args.journal, encoding="utf-8") as journal:
        for number, line in enumerate(journal, 1):
            if not line.strip():
                continue
            try:
                result = audit(json.loads(line))
            except (ValueError, KeyError, TypeError, struct.error) as error:
                raise SystemExit(f"Invalid journal line {number}: {error}") from error
            if result is not None:
                print(json.dumps(result))


if __name__ == "__main__":
    main()
