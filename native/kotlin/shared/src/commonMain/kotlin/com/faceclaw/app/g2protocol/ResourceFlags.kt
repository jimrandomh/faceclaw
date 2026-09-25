package com.faceclaw.app

/** Resource header types and flags; mirrored in g2flash/patches/resource_cache.h. */
const val CFW_RESOURCE_TYPE_IMAGE = 0
const val CFW_RESOURCE_TYPE_FONT = 1
const val CFW_RESOURCE_TYPE_DISPLAY_LIST = 2
const val CFW_RESOURCE_TYPE_MASK = 3
const val CFW_RESOURCE_FLAG_LARGE = 4
const val CFW_RESOURCE_FLAG_RLE = 8
const val CFW_RESOURCE_IMAGE_FLAGS_MASK = CFW_RESOURCE_FLAG_LARGE or CFW_RESOURCE_FLAG_RLE
