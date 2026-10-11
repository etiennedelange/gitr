import { useEffect, useRef } from 'react'
import { api } from './api'
import { notifyError } from './hooks'
import { createWheelZoomAccumulator, stepZoom } from './lib/zoom'
import { useApp } from './store'

/**
 * Ctrl + wheel / trackpad pinch zooms the whole UI one preset per step.
 * The backend applies the zoom to the webview and persists it to config.toml.
 */
export function useWheelZoom(initialZoom: number | undefined) {
  const seeded = useRef(false)

  useEffect(() => {
    if (seeded.current || initialZoom === undefined) return
    seeded.current = true
    useApp.getState().setZoom(initialZoom)
  }, [initialZoom])

  useEffect(() => {
    const accumulate = createWheelZoomAccumulator()
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const dir = accumulate(e.deltaY, e.deltaMode)
      if (!dir) return
      const { zoom: prev, setZoom } = useApp.getState()
      const next = stepZoom(prev, dir)
      if (next === prev) return
      setZoom(next)
      api.setZoom(next).catch((err) => {
        if (useApp.getState().zoom === next) setZoom(prev)
        notifyError(err)
      })
    }
    window.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => window.removeEventListener('wheel', onWheel, { capture: true })
  }, [])
}
