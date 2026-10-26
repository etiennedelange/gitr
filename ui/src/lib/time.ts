const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

// A non-breaking space keeps a number with its unit ("5 min"), so a narrow column never splits them.
const NBSP = ' '

/**
 * "just now", "5 min ago", "3 h ago", "yesterday", then the date in the user's locale: "3 Oct" or
 * "Oct 3", with the year when it isn't this one (local time). `locale` is for tests.
 */
export function relativeTime(unix: number, now = Date.now(), locale?: string): string {
  const secs = (now - unix * 1000) / 1000
  if (secs < 60) return 'just now'
  if (secs < 3600) return `${Math.floor(secs / 60)}${NBSP}min ago`
  const then = new Date(unix * 1000)
  const today = new Date(now)
  const days = Math.round((startOfDay(today) - startOfDay(then)) / 86_400_000)
  if (days === 0) return `${Math.floor(secs / 3600)}${NBSP}h ago`
  if (days === 1) return 'yesterday'
  const sameYear = then.getFullYear() === today.getFullYear()
  return then.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: sameYear ? undefined : 'numeric' })
}

/** The date and time in the user's locale, "3 Oct 2026, 14:02" or "Oct 3, 2026, 2:02 PM", for tooltips and the commit header. */
export function absoluteTime(unix: number, locale?: string): string {
  return new Date(unix * 1000).toLocaleString(locale, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}
