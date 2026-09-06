import { rasterizeSvg as render } from './ios-graphics'
export function rasterizeSvg(svg: string, size: number, strokeWidth: number) {
  // Shared icon sources rely on the Android renderer's white, rounded
  // stroke defaults. Supply those explicitly for a standards SVG renderer.
  const source = svg.replace(/<svg\b([^>]*)>/, (_tag, attributes: string) => {
    const defaults = { xmlns: 'http://www.w3.org/2000/svg', width: '24', height: '24',
      stroke: svg.includes('fill="none"') ? '#ffffff' : 'none', fill: '#ffffff', 'stroke-width': String(strokeWidth),
      'stroke-linecap': 'round', 'stroke-linejoin': 'round' }
    const missing = Object.entries(defaults).filter(([key]) => !new RegExp(`\\b${key}=`).test(attributes))
      .map(([key, value]) => ` ${key}="${value}"`).join('')
    return `<svg${attributes}${missing}>`
  })
  return render(source, size)
}
