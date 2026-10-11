import { describe, expect, it } from 'vite-plus/test'
import { relativeTime } from './time'

// Local-time noon, so day boundaries don't depend on the machine's time zone.
const now = new Date(2026, 9, 3, 12, 0, 0).getTime()
const at = (d: Date) => Math.floor(d.getTime() / 1000)

describe('relativeTime', () => {
  it('counts minutes and hours today', () => {
    expect(relativeTime(at(new Date(2026, 9, 3, 11, 59, 30)), now)).toBe('just now')
    expect(relativeTime(at(new Date(2026, 9, 3, 11, 55)), now)).toBe('5 min ago')
    expect(relativeTime(at(new Date(2026, 9, 3, 9, 0)), now)).toBe('3 h ago')
  })

  it('says yesterday for the previous calendar day, then the date', () => {
    expect(relativeTime(at(new Date(2026, 9, 2, 23, 0)), now)).toBe('yesterday')
    expect(relativeTime(at(new Date(2026, 8, 30, 12, 0)), now)).toBe('30 Sep')
    expect(relativeTime(at(new Date(2025, 9, 3, 12, 0)), now)).toBe('3 Oct 2025')
  })
})
