import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DropMenu } from './components/DropMenu'

afterEach(cleanup)

const setup = () => {
  const onSelect = vi.fn()
  render(
    <>
      <DropMenu label="Open in ADO" items={[{ label: 'Repository', onSelect }]} />
      <DropMenu label="Open" items={[{ label: 'Explorer', onSelect: vi.fn() }]} />
      <p>elsewhere</p>
    </>,
  )
  const details = (name: string) => screen.getByText(name).closest('details') as HTMLDetailsElement
  return { onSelect, details }
}

describe('DropMenu', () => {
  it('opens on click and closes on a second click', () => {
    const { details } = setup()
    fireEvent.click(screen.getByText('Open'))
    expect(details('Open').open).toBe(true)
    fireEvent.click(screen.getByText('Open'))
    expect(details('Open').open).toBe(false)
  })

  it('closes on Escape and returns focus to its button', () => {
    const { details } = setup()
    fireEvent.click(screen.getByText('Open'))
    fireEvent.keyDown(screen.getByText('Explorer'), { key: 'Escape' })
    expect(details('Open').open).toBe(false)
    expect(document.activeElement).toBe(details('Open').querySelector('summary'))
  })

  it('closes when an item is chosen, after running it', () => {
    const { onSelect, details } = setup()
    fireEvent.click(screen.getByText('Open in ADO'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Repository' }))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(details('Open in ADO').open).toBe(false)
  })

  it('closes on a click elsewhere', () => {
    const { details } = setup()
    fireEvent.click(screen.getByText('Open'))
    fireEvent.mouseDown(screen.getByText('elsewhere'))
    expect(details('Open').open).toBe(false)
  })

  it('closes the other menu when one opens', () => {
    const { details } = setup()
    fireEvent.click(screen.getByText('Open in ADO'))
    fireEvent.mouseDown(screen.getByText('Open'))
    fireEvent.click(screen.getByText('Open'))
    expect(details('Open in ADO').open).toBe(false)
    expect(details('Open').open).toBe(true)
  })
})

describe('DropMenu focus', () => {
  it('closes when keyboard focus leaves it', () => {
    const onSelect = vi.fn()
    render(
      <>
        <DropMenu label="Open" items={[{ label: 'Explorer', onSelect }]} />
        <button>elsewhere</button>
      </>,
    )
    fireEvent.click(screen.getByText('Open'))
    const item = screen.getByRole('menuitem', { name: 'Explorer' })
    fireEvent.focusOut(item, { relatedTarget: screen.getByRole('button', { name: 'elsewhere' }) })
    expect((screen.getByText('Open').closest('details') as HTMLDetailsElement).open).toBe(false)
  })

  it('stays open while focus moves between its own items', () => {
    render(
      <DropMenu
        label="Open"
        items={[
          { label: 'A', onSelect: vi.fn() },
          { label: 'B', onSelect: vi.fn() },
        ]}
      />,
    )
    fireEvent.click(screen.getByText('Open'))
    fireEvent.focusOut(screen.getByRole('menuitem', { name: 'A' }), { relatedTarget: screen.getByRole('menuitem', { name: 'B' }) })
    expect((screen.getByText('Open').closest('details') as HTMLDetailsElement).open).toBe(true)
  })
})
