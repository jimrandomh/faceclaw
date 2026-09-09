# Generated extension contract reference

This file is generated from `sdk/src/main/java/com/faceclaw/sdk/ExtensionContract.java`.
The Java contract remains authoritative for validation, dependency cycles, owner limits, same-owner checks, semantic compatibility, and runtime bounds.

| Feature | Configuration key | Accepted value |
| --- | --- | --- |
| `ui.launcher` | `label` | text, at most 100 characters |
| `ui.launcher` | `filesDefaultView` | `icons` or `list` |
| `ui.navigation` | `rootBack` | `sleep` or `switcher` |
| `ui.navigation` | `doubleTap` | `back` or `sleep` |
| `ui.navigation` | `tapHold` | `switcher` or `app-menu` |
| `ui.navigation` | `hold` | `app-menu` or `system-menu` |
| `ui.navigation` | `wakeFocus` | `window` or `sidebar` |
| `ui.app-menu` | `title` | text, at most 100 characters |
| `ui.app-menu` | `systemTitle` | text, at most 100 characters |
| `ui.app-menu` | `displayOffFirst` | boolean |
| `ui.app-menu` | `systemActionsLast` | boolean |
| `ui.window-layout` | `centered` | boolean |
| `ui.window-layout` | `sidebarMode` | `overlay` or `persistent` |
| `ui.window-layout` | `switcherHeight` | `display` or `minimum` |
| `ui.window-layout` | `dividerWidth` | integer 1–4 |
| `ui.window-layout` | `ownTopBar` | boolean |
| `ui.window-layout` | `ownHeightMode` | `min` or `medium` or `max` |
| `ui.window-layout` | `inputDialogs` | `compact` or `viewport` |
| `ui.typography` | `font` | SDK-bundled filename |
| `ui.typography` | `size` | integer 8–20 |
| `ui.typography` | `raster` | `antialiased` or `crisp` or `hinted` |
| `ui.typography` | `borderWidth` | integer 1–4 |
| `ui.typography` | `selectionBorderWidth` | integer 1–5 |
| `ui.typography` | `cardRadius` | integer 0–24 |
| `ui.notifications` | `label` | text, at most 100 characters |
| `assistant` | `label` | text, at most 100 characters |
| `transcription` | `label` | text, at most 100 characters |
| `refinement` | `label` | text, at most 100 characters |
| `device-tools` | `label` | text, at most 100 characters |
| `notification-content` | `label` | text, at most 100 characters |

`requires` contains other known feature IDs. The host and SDK reject unknown features, duplicate declarations, self-dependencies, missing dependencies, and cycles.
Configuration properties are optional; an empty object is valid for features that use only the generic `label` field.
