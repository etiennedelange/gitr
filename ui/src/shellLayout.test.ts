import { describe, expect, it } from 'vite-plus/test'
import css from './index.css?raw'

// jsdom does no grid layout, so this checks the rule that keeps the sheet in its column.
describe('shell grid', () => {
  it('keeps the sheet in the third column when narrow windows hide the splitter', () => {
    // Below 1100px the splitter is display: none. An auto-placed sheet would then take the splitter's
    // 0-wide track and every view would be blank (900 to 1099px wide).
    expect(css).toMatch(/@media \(max-width: 1099px\)[\s\S]*?\.app > \.splitter\s*\{\s*display:\s*none/)
    expect(css).toMatch(/\n\.main\s*\{[^}]*grid-column:\s*3;/)
  })
})
