import { type ImageSource } from '@nativescript/core'

import { type GrayImage } from '../graphics/image'
import { previewPixels, whiteIconPixels } from './ios-graphics'

/** Build the phone-UI preview for a frame (brightened like Android's). */
export function grayImageToPreviewSource(image: GrayImage): ImageSource | null {
  const baked = image.withDrawsBaked()
  return previewPixels(baked.pixels, baked.width, baked.height)
}

/**
 * A glasses icon as a white-on-transparent phone image (gray becomes alpha),
 * for the dark header.
 */
export function grayImageToWhiteIconSource(image: GrayImage): ImageSource | null {
  const baked = image.withDrawsBaked()
  return whiteIconPixels(baked.pixels, baked.width, baked.height)
}
