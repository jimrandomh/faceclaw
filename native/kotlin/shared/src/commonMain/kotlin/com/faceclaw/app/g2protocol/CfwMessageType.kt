package com.faceclaw.app

/** Message IDs and header flags mirror g2flash/patches/zlib_glue.c. */
/** Retired wire ID; used internally by the phone optimizer. */
const val CFW_MSG_BOUNDING_BOX = 3
const val CFW_MSG_BUZZER = 5
/** Retired wire ID; used internally by the phone optimizer. */
const val CFW_MSG_FULL_FRAME = 6
const val CFW_MSG_DIAGNOSTICS = 7
/**
 * A CFW_MSG_DIAGNOSTICS sub-op the firmware acknowledges and ignores (it acts on 0, 1 and 2 only):
 * the keepalive and the bandwidth benchmark's payloads. Mirrors g2flash/patches/zlib_glue.c.
 */
const val CFW_DIAGNOSTICS_NOOP = 0x7f
/** Retired wire ID; used internally by the phone optimizer. */
const val CFW_MSG_MULTI_SEGMENT = 8
/** Retired wire ID; used internally by the phone optimizer. */
const val CFW_MSG_RECT_COPY = 9
const val CFW_MSG_COMPASS = 10
const val CFW_MSG_CLEANUP = 11
const val CFW_MSG_RETIRED_12 = 12
const val CFW_MSG_RETIRED_13 = 13
const val CFW_MSG_RETIRED_14 = 14
/** Retired wire ID; used internally by the phone optimizer. */
const val CFW_MSG_STOCK_FONT_STRING = 15
const val CFW_MSG_AMBIENT_LIGHT = 16
const val CFW_MSG_RING_BATTERY = 17
const val CFW_MSG_RETIRED_CACHE_WRITE = 18
/** Retired wire ID; used internally by the phone optimizer. */
const val CFW_MSG_CACHED_IMAGE = 19
/** Retired wire ID; used internally by the phone optimizer. */
const val CFW_MSG_CACHED_TEXT = 20
const val CFW_MSG_UPLOAD_RESOURCE = 21
const val CFW_MSG_EVICT_RESOURCE = 22
const val CFW_MSG_PANEL_READ = 23
const val CFW_MSG_PANEL_WRITE = 24
const val CFW_MSG_PANEL_PATTERN = 25
const val CFW_MSG_DRAW_CALLS = 26
const val CFW_MSG_SET_ROOT_DISPLAY_LIST = 27
const val CFW_MSG_PRESENT = 28
const val CFW_MSG_CREATE_SURFACE = 29
const val CFW_MSG_BRIGHTNESS = 30
const val CFW_MSG_ENTER_EVENHUB = 31
/**
 * `[34]{len:u8, message}*` (embedded modes 16 and 30) plus prelude and page. 32 and 33
 * are taken by the per-lens battery and the ANCS relay's phone-link release.
 */
const val CFW_MSG_SESSION_START = 34
const val CFW_MSG_TYPE_MASK = 127
const val CFW_MSG_FLAG_LENSES_DIFFER = 128
