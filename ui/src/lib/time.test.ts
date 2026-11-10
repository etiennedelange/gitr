import { describe, expect, it } from 'vite-plus/test'
import { absoluteTime, relativeTime } from './time'

// Local-time noon, so day boundaries don't depend on the machine's time zone.
const now = new Date(2026, 9, 3, 12, 0, 0).getTime()
const at = (d: Date) => Math.floor(d.getTime() / 1000)

describe('relativeTime', () => {
  it('counts minutes and hours today, the number kept with its unit', () => {
    expect(relativeTime(at(new Date(2026, 9, 3, 11, 59, 30)), now)).toBe('just now')
    expect(relativeTime(at(new Date(2026, 9, 3, 11, 55)), now)).toBe('5 min ago')
    expect(relativeTime(at(new Date(2026, 9, 3, 9, 0)), now)).toBe('3 h ago')
  })

  it('says yesterday for the previous calendar day, then the date', () => {
    expect(relativeTime(at(new Date(2026, 9, 2, 23, 0)), now, 'en-GB')).toBe('yesterday')
    expect(relativeTime(at(new Date(2026, 8, 30, 12, 0)), now, 'en-GB')).toBe('30 Sept')
    expect(relativeTime(at(new Date(2025, 9, 3, 12, 0)), now, 'en-GB')).toBe('3 Oct 2025')
  })

  it('writes dates in the locale’s order', () => {
    expect(relativeTime(at(new Date(2026, 8, 30, 12, 0)), now, 'en-US')).toBe('Sep 30')
    expect(relativeTime(at(new Date(2025, 9, 3, 12, 0)), now, 'en-US')).toBe('Oct 3, 2025')
  })
})

describe('absoluteTime', () => {
  it('follows the locale’s date order and clock', () => {
    const t = at(new Date(2026, 9, 3, 14, 2))
    expect(absoluteTime(t, 'en-GB')).toBe('3 Oct 2026, 14:02')
    expect(absoluteTime(t, 'en-US').replace(/\s/g, ' ')).toBe('Oct 3, 2026, 2:02 PM')
  })
})
