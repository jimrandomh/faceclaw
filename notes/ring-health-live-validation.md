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

## Clock investigation (follow-up)

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

`python3 tools/ring-clock-audit.py <journal.jsonl>` reports the relevant time
fields without emitting measurement values. It reads the journal without
modifying it. All instants below are UTC, avoiding local display ambiguity.

| Field | Observed value |
| --- | --- |
| Phone reception of fresh HR page | Sep 18 04:07:28.792 |
| Latest HR timestamp in that page | Sep 18 11:07:25 |
| Difference | +25,196.208 seconds (seven hours minus 3.792 seconds) |
| Daily anchor, shared across metric pages | Sep 17 12:47:44 |
| Timezone in those pages | -420 minutes |
| Anchor's local time | 05:47:44, not midnight |
| Latest HRV / SpO2 timestamps | Sep 18 03:39:03 / 03:38:51 |

The handshake explicitly sends `phone Unix seconds - UTC offset`, or UTC +7h
in PDT. The fresh HR timestamp is consistent with that incorrect initialization.
The older HRV/SpO2 timestamps precede reception and cannot be assumed to have
the same error. The unchanged bucket index 20 and non-midnight anchor also
indicate that a clock change did not rebuild all existing daily metadata.
We cannot infer trustworthy dates for those buckets from the latest HR time.

The sibling openCFW checkout's `r1/docs/correlation/CLOCK-PRODUCTION-CORRELATION.md`
and recovered RTC evidence describe command `00:05` as UTC epoch seconds plus a
separate signed timezone offset. The clock applies that offset for local-calendar
bucketing. Command `00:0e` is a health-recording setting, not a second clock setter.
The inherited comments claiming that UTC+offset and double sleep correction were
protocol requirements have therefore been replaced with explicit migration TODOs.

**Do not silently rewind the live ring.**
`r1/docs/correlation/TIME-HEALTH-ROLLOVER-CORRELATION.md` and
`r1_health_plan_time_transition` document stock behavior: a backward jump of at
least 3,600 seconds requests health-database formatting and synchronization cursor
reset. A seven-hour correction can erase history still held only by the ring.
The local phone-store backup is `/tmp/faceclaw-health-before-clock.tar`; it
preserves received frames and derived records, not every possible unreceived page.
No clock correction or historical timestamp rewrite was performed in this follow-up.

The next controlled test is to finish a health pull, preserve its raw pages, then
set `00:05` to actual UTC seconds with the phone's offset still in its separate
field. Remove the matching display corrections for new records and keep old
ambiguous records archived separately. Verify the command response, fresh HR time
against receipt time, and a new daily anchor against local midnight. This test
requires permission for the firmware's possible history reset. Sleep clock and
duration units still require a real sleep DATA page; no sleep has been observed
on this new ring.

## Remaining initial-review fixes

- Ring connection, handshake, health waits and page ACKs now run on one dedicated
  ring worker. GATT locking is per address, so the glasses sender continues while
  the ring connects or waits for pages. Shutdown interrupts and joins both workers.
- Daily sleep totals include all sessions attributed to the wake-up day. The
  detail view orders their stage blocks chronologically and leaves unrecorded
  intervals unknown instead of counting them as sleep.
- Startup registers the share-intent handler and native user agent once.

Validation: Android build and full TypeScript check passed; focused health and
ring tests passed (36 passed, one pre-existing timezone-specific skip). Installed
on the Pixel 7a. The 21:19:58–21:20:08 local-time pull answered all five health
requests on the ring worker while the glasses sender delivered and received
ACKs for images roughly every 0.8 seconds throughout that interval. Battery
remained 85%. The historical timestamp heuristics are still unchanged.
