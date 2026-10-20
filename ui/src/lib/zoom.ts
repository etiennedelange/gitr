export const ZOOM_PRESETS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200] as const
export const DEFAULT_ZOOM = 100

const DIFF_ZOOM_KEY = 'diffZoom'

/** The diff's own zoom in percent, kept per machine like the diff layout. */
export function loadDiffZoom(): number {
  try {
    const z = Number(localStorage.getItem(DIFF_ZOOM_KEY))
    return ZOOM_PRESETS.includes(z as (typeof ZOOM_PRESETS)[number]) ? z : DEFAULT_ZOOM
  } catch {
    return DEFAULT_ZOOM
  }
}

export function saveDiffZoom(zoom: number) {
  try {
    if (zoom === DEFAULT_ZOOM) localStorage.removeItem(DIFF_ZOOM_KEY)
    else localStorage.setItem(DIFF_ZOOM_KEY, String(zoom))
  } catch {
    // Storage can be unavailable; the zoom then lasts until the app closes.
  }
}

/** Next preset in direction `dir`, clamped to the ends. Non-preset input snaps to the nearest preset first. */
export function stepZoom(current: number, dir: 1 | -1): number {
  let idx = ZOOM_PRESETS.indexOf(current as (typeof ZOOM_PRESETS)[number])
  if (idx < 0) {
    idx = ZOOM_PRESETS.reduce((best, p, i) => (Math.abs(p - current) < Math.abs(ZOOM_PRESETS[best] - current) ? i : best), 0)
  }
  return ZOOM_PRESETS[Math.max(0, Math.min(ZOOM_PRESETS.length - 1, idx + dir))]
}

const LINE_PX = 40
const PAGE_PX = 800

/**
 * Accumulates wheel deltas so a mouse notch (~100px) is one step, while the many tiny deltas
 * from a trackpad pinch don't race through all presets. Returns +1 (zoom in), -1 (out) or 0.
 */
export function createWheelZoomAccumulator(threshold = 50) {
  let acc = 0
  return (deltaY: number, deltaMode = 0): 1 | -1 | 0 => {
    const px = deltaMode === 1 ? deltaY * LINE_PX : deltaMode === 2 ? deltaY * PAGE_PX : deltaY
    if (acc !== 0 && Math.sign(px) !== Math.sign(acc)) acc = 0
    acc += px
    if (Math.abs(acc) < threshold) return 0
    const dir = acc < 0 ? 1 : -1
    acc = 0
    return dir
  }
}
