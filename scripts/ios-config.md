# iOS config transfer

Requires Xcode, Python 3, a development build with `FaceclawConfigPort`, and an
unlocked/trusted iPhone. Both commands restart Faceclaw, briefly interrupting its
Bluetooth and Terminal sessions.

```sh
scripts/pull_config_ios.sh                         # faceclaw_settings.ios.jsonc
scripts/push_config_ios.sh                         # import the edited file
scripts/pull_config_ios.sh -f /tmp/settings.jsonc --device IPHONE_UDID
scripts/push_config_ios.sh faceclaw_settings.xml   # legacy Android export
```

Use `--device` / `-d` or set `IOS_DEVICE` when more than one device is connected.
Without either, the script selects the only device with an active Xcode tunnel.
For the simulator, add `--simulator` (defaults to `booted`; `--device` selects one).

Both platforms use [schema 2 JSONC](settings-config.md), preserving nested values:

```jsonc
{
  "schema": 2,
  "settings": {
    "terminal.connections": [],
    "terminal.autoReconnect": true
  }
}
```

Pull accepts an `.xml` output filename to write Android shared-preferences XML.
Push detects JSONC or legacy XML by content, migrates schema 1, and supports
strings, booleans, numbers, objects and arrays.
Malformed input, unsupported values and files over 2 MiB fail before restarting
the app. Push **merges supplied keys**, preserving omitted settings (including
phone-specific pairing). To clear a value, supply its empty/default value.

Transfers use `devicectl` app-container access. The app consumes a uniquely
identified request at bootstrap, before loading settings getters and workers;
it applies imports through the shared JSONC store. Each successful push first
saves the previous file to `Library/faceclaw_settings.jsonc.previous`. Replies are checked
against the request ID, so a stale export cannot appear to confirm an import.

Exports may contain API keys and Terminal tokens. Scripts do not print values,
write local exports with mode 600, and remove their private temporary directory
on exit. Default export filenames are gitignored. Device request/reply/backup
files stay in the private Library directory, outside Files/Finder Documents.

Terminal's configured `g2mirror://` scheme uses plain WebSockets; `g2mirrors://`
uses TLS. The iOS build declares local networking and an explicit ATS exception
for the current development server `100.68.94.67`. On iOS 17+, another literal IP
requires its own build-time `NSExceptionDomains` entry, or a TLS endpoint. The
exception does not disable TLS certificate verification. See Apple's
[IP exception rules](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsexceptiondomains).
