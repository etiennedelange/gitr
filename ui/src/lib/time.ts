const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/** "just now", "5 min ago", "3 h ago", "yesterday", "3 Oct", "3 Oct 2025" (local time). */
export function relativeTime(unix: number, now = Date.now()): string {
  const secs = (now - unix * 1000) / 1000
  if (secs < 60) return 'just now'
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`
  const then = new Date(unix * 1000)
  const today = new Date(now)
  const days = Math.round((startOfDay(today) - startOfDay(then)) / 86_400_000)
  if (days === 0) return `${Math.floor(secs / 3600)} h ago`
  if (days === 1) return 'yesterday'
  const date = `${then.getDate()} ${MONTHS[then.getMonth()]}`
  return then.getFullYear() === today.getFullYear() ? date : `${date} ${then.getFullYear()}`
}

/** "3 Oct 2026, 14:02" (local time), for tooltips and the commit header. */
export function absoluteTime(unix: number): string {
  const d = new Date(unix * 1000)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${hh}:${mm}`
}
