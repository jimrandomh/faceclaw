import { GrayImage } from '../graphics/image'
declare const com: any
export function rasterizeSvg(svg: string, size: number, strokeWidth: number): GrayImage | null {
  const bytes = com.faceclaw.app.IconRenderer.renderSvgGray(svg, size, strokeWidth)
  if (!bytes || bytes.length < size * size) return null
  const image = new GrayImage(size, size, 0)
  for (let i = 0; i < size * size; i++) image.pixels[i] = bytes[i] & 0xff
  return image
}
