# Analytics report protocol

The phone app (app/analytics/) sends opt-in usage statistics to
`https://stats.faceclaw.org/v1/report`, at most about once a day per install,
plus hourly retries after a failure. Nothing is sent, or kept on the phone,
while Settings > Privacy > Data collection is None. What each level collects
is described in app/analytics/analytics-store.ts and in the privacy policy
(../PRIVACY); this file is the wire format.

## Request

`POST /v1/report` with a JSON body of at most 64 KiB:

```json
{
  "schema": 1,
  "reportId": "0f8fad5b-d9cb-469f-a165-70867728950e",
  "installId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "level": "minimal",
  "createdAt": "2026-10-10T12:00:00.000Z",
  "app": { "version": "0.8.3", "platform": "android", "build": "official" },
  "counters": { "2026-10-10": { "g2.connect-attempt": 3, "g2.session-ready": 3 } },
  "snapshot": { "device.g2.paired": true, "device.r1.paired": false }
}
```

- `reportId`: a random UUID per report. The phone resends a report until it
  gets a 2xx, so the server stores each id once and treats repeats as
  success.
- `installId`: a random UUID made when analytics is first turned on, deleted
  (with everything else) when it is turned off. It ties one install's reports
  together and nothing else.
- `level`: `minimal` or `full`, the setting when the report was sent. A
  minimal report carries only minimal data.
- `createdAt`: when the phone sealed the report (its counters may cover
  earlier days, e.g. after a failed upload).
- `app.build`: `official` (signed with the release key), `self-built` (a
  release build signed with another key), `debug` (a debuggable build), or
  `unknown`.
- `counters`: UTC day, then counter name (`[a-z0-9][a-z0-9_.:-]*`), then a
  non-negative integer count.
- `snapshot`: state when the report was sealed, as flat keys
  (`[A-Za-z0-9][A-Za-z0-9_.:-]*`) to a boolean, number or string of up to 200
  characters.

The server ignores unknown fields and rejects (400) a report with anything
malformed or over its limits (100 days, 2000 counters, 500 snapshot keys).

## Response

`200 {"ok": true}` once stored (or already stored). Errors are
`{"error": "..."}` with 400 (malformed, not retried), 405, 413 (too large),
429 (rate-limited by nginx, retried) or 500 (retried). Later versions may add
fields to the 200 response, such as the latest released version for update
checks.

## Current counters and snapshot keys

Minimal level:

| Name | Kind | Meaning |
| --- | --- | --- |
| `g2.connect-attempt`, `g2.session-ready` | counter | Connection attempts to the glasses, and those that got a working session |
| `g2.failure.<reason>` | counter | Transport failures that dropped or aborted a session, by reason (e.g. `ack-timeout`, `write-failed`, `glasses-not-found`, `left-arm-not-found`, `heartbeat-ack-timeout`, `cfw-recovery-retry-limit`) |
| `g2.session-end.<cause>` | counter | Working sessions ending: `failure`, `arm-drop`, `requested` |
| `g2.session-length.<bucket>` | counter | How long ended sessions lasted: `under-1m`, `1m-10m`, `10m-1h`, `over-1h` |
| `g2.arm-drop.left`, `g2.arm-drop.right` | counter | An arm's BLE link dropping mid-session |
| `g2.disconnect-requested` | counter | Disconnects the app asked for |
| `g2.unpaired`, `g2.incompatible-firmware` | counter | Connections halted for a missing bond or incompatible firmware |
| `g2.ack-timeout`, `g2.cfw-replay`, `g2.cfw-nack` | counter | Recovered message-level problems |
| `g2.firmware-abnormal-exit`, `g2.firmware-system-exit` | counter | Firmware closing the app's page outside a shutdown |
| `g2.auth-unacknowledged`, `g2.even-app-conflict` | counter | Security auth not acked; write failures blamed on the Even app |
| `ring.direct.connect`, `ring.direct.disconnect` | counter | Direct (not via glasses) R1 ring links |
| `ble.gatt-status.<code>` | counter | Android GATT connection-state callbacks with a non-success status (e.g. 8, 133) |
| `ble.ios-disconnect-error.<code>` | counter | iOS disconnects with an error |
| `device.g2.used`, `device.g2.touchpad-used`, `device.r1.used`, `device.wear.reachable`, `device.wear.used` | counter (1 per day) | Which devices were in use that day |
| `device.g2.paired`, `device.r1.paired` | snapshot | Whether glasses and a ring are paired |
| `device.g2.preview-only` | snapshot | Whether the app is in phone-preview-only mode |
| `device.r1.connection` | snapshot | `glasses` or `direct` ring connection |

Full level adds:

| Name | Kind | Meaning |
| --- | --- | --- |
| `apikey.<kind>` | snapshot | Whether an API key or token of that kind is set (`anthropic`, `openai`, `elevenlabs`, `soniox`, `mapbox`, `roam`, `nightscout`, `agent-bridge`, `evenhub`), never the key |
| `config.nightscout-site` | snapshot | Whether a Nightscout site is set (not its URL) |
| `config.terminal-connections`, `config.t3code-environments` | snapshot | How many are configured |
| `config.ui-font` | snapshot | The UI font: a bundled font's name and size, `installed:<size>` for a user-installed one, or the bitmap face |
| `setting.<key>` | snapshot | The value of every setting chosen from fixed options (on/off and pick-one settings), by its storage key; free-text settings are never included |

Connection counts are kept by the shared Kotlin session core
(ConnectionCounters.kt) and drained into the app's store every few minutes.
