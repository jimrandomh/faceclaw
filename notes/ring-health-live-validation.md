# R1 live sync, 2026-09-17

Validated on the connected Pixel 7a and an R1 reporting firmware `2.0.7.0003`.

## Connection and decoding

Direct mode was effective. The first connection attempt timed out after 20 seconds;
the retry connected, subscribed to both notify characteristics, completed the
handshake, and received responses to all five health requests. Pairing was not the
reason health measurements were absent.

The incoming daily records do not have the four-byte footer assumed by PR #26.
The rejected HR, SpO2 and activity frame lengths were respectively 37, 33 and 80
bytes, matching two one-byte hourly groups, one one-byte hourly group, and eight
activity buckets without a footer. Subtracting four bytes also made a one-group
HRV page appear to contain one-byte values instead of the actual two-byte values.

Payload bytes 3–4 are a signed timezone offset in minutes. `10 ff` is EDT's
offset of -240; it is not a magic marker. This R1 reports `5c fe`, or -420.
The handshake's timezone field now also uses the phone's actual offset.

The corrected serializers are corroborated by the sibling openCFW checkout at
commit `fc1040f1`, particularly `r1_health_encode_daily_u8`,
`r1_health_encode_daily_u16`, `r1_activity_encode_daily`, and `r1_sleep_encode`
in `r1/src/r1_health.c`. Regression tests use synthetic records matching those
layouts rather than checking private biometric captures into the repository.

After installing the fixes, a live sync decoded four pages and stored 31 samples
across heart rate, HRV, SpO2, steps and calories. The fixture files and marker were
removed, and `live-marker.json` was present. There was no sleep DATA page in that
sync; sleep has not been validated on this ring.

## Battery

Device-channel `00:01` returns seven status bytes after the two-byte prefix.
The first is battery percentage; the next is the charge-state enum. This matches
openCFW's `get_device_status` and `r1_charge_state`. The captured percentage was
85%, independently confirmed by the user in the Even app.

Faceclaw now uses the direct status while the ring link is connected, falling
back to the glasses report on disconnect. This does not repair the separate
stock ring-to-glasses connection or its cached battery reading.

## Remaining clock validation

Successful decoding does not establish correct chart timestamps. This ring's
reported day anchor had nonzero hour/minute/second components; the inherited
`anchor + index * interval - clock correction` conversion produced hourly bucket
starts at `:47:44`. The relationship between that anchor, current ring time, and
the clock changes made by Faceclaw and Even remains unverified. Do not normalize
these to midnight or change the clock corrections without further evidence.

CRC-valid frames are now retained before acknowledgement in the app-private
`files/health/ring-frames.jsonl`, with reception time and original bytes. This
preserves evidence and permits later reprocessing; it is not yet an automatic
replay/import path. The earlier rejected pages were not journaled by the old
build, and re-delivery of them is not guaranteed.
