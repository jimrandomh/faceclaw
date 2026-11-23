package com.faceclaw.app

/**
 * Draw-call flags, bounding-box flags, and the border sentinel mirror g2flash/patches/display_list.c.
 * Image/text options mirror g2flash/patches/texture_draw.h.
 */
/** Common draw-call header bits. */
const val DRAW_FLAG_RESOURCE_TARGET = 1
const val DRAW_FLAG_DEPTH = 2
/** Revision 35: an x/y s16, w/h u16 clip rect follows the depth byte. */
const val DRAW_FLAG_CLIP = 4
/** Revision 45: the clip's x, y, width and height follow as extended values instead, so it can move. */
const val DRAW_FLAG_CLIP_ANIMATED = 8
const val DRAW_FLAGS_MASK = DRAW_FLAG_RESOURCE_TARGET or DRAW_FLAG_DEPTH or DRAW_FLAG_CLIP or DRAW_FLAG_CLIP_ANIMATED

/** A line with an endpoint coordinate further out than this draws nothing. */
const val DRAW_LINE_COORDINATE_LIMIT = 4096

/** Bounding-box payload flag: u16 coordinates/sizes instead of aligned compact units. */
const val DRAW_BBOX_FLAG_U16 = 1

/** Image/text options. */
const val CFW_TEXTURE_OPT_BRIGHTNESS_MASK = 15
const val CFW_TEXTURE_OPT_TRANSPARENT = 16
const val CFW_TEXTURE_OPT_INVERSE = 32

/** Rounded-rectangle border sentinel, not a color or flag bit. */
const val DRAW_ROUNDED_RECT_NO_BORDER = 16
/** Revision 36: the rounded rectangle's optional outside color is absent (bridge sentinel). */
const val DRAW_ROUNDED_RECT_NO_OUTSIDE = 16
