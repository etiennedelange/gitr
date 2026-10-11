import { describe, expect, it } from 'vite-plus/test'
import { createWheelZoomAccumulator, stepZoom, ZOOM_PRESETS } from './zoom'

describe('stepZoom', () => {
  it('steps through every preset in both directions', () => {
    let z = 50
    const up = [z]
    while (z !== 200) up.push((z = stepZoom(z, 1)))
    expect(up).toEqual([...ZOOM_PRESETS])
    const down = [z]
    while (z !== 50) down.push((z = stepZoom(z, -1)))
    expect(down).toEqual([...ZOOM_PRESETS].reverse())
  })

  it('clamps at the ends', () => {
    expect(stepZoom(200, 1)).toBe(200)
    expect(stepZoom(50, -1)).toBe(50)
  })

  it('snaps non-preset input to the nearest preset', () => {
    expect(stepZoom(102, 1)).toBe(110)
    expect(stepZoom(102, -1)).toBe(90)
    expect(stepZoom(999, 1)).toBe(200)
  })
})

describe('createWheelZoomAccumulator', () => {
  it('turns one mouse notch into one step; wheel up zooms in', () => {
    const acc = createWheelZoomAccumulator()
    expect(acc(-100)).toBe(1)
    expect(acc(100)).toBe(-1)
  })

  it('needs many small trackpad deltas for one step', () => {
    const acc = createWheelZoomAccumulator()
    const results = Array.from({ length: 10 }, () => acc(-8))
    expect(results.filter((r) => r === 1)).toHaveLength(1)
    expect(results.filter((r) => r !== 0)).toHaveLength(1)
  })

  it('normalises line-mode deltas', () => {
    const acc = createWheelZoomAccumulator()
    expect(acc(3, 1)).toBe(-1)
  })

  it('resets when the direction changes', () => {
    const acc = createWheelZoomAccumulator()
    expect(acc(-40)).toBe(0)
    expect(acc(40)).toBe(0)
    expect(acc(20)).toBe(-1)
  })
})
