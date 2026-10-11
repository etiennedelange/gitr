// Sets the theme before first paint so the window never flashes the wrong one.
// Mirrors resolveTheme() in src/theme.ts: 'light' | 'dark' saved, otherwise follow Windows.
try {
  var saved = localStorage.getItem('theme')
  var dark = saved === 'dark' || (saved !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
} catch {
  document.documentElement.dataset.theme = 'light'
}
