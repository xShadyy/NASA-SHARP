import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { CropIcon, XIcon } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import type { CaptureRegion } from '@/lib/map-capture'
import './CaptureSelection.css'

type Point = { x: number, y: number }
type CaptureSelectionProps = {
  onSelected: (region: CaptureRegion) => void
  onCancel: () => void
}

function rectangle(start: Point, end: Point): CaptureRegion {
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(start.x - end.x), height: Math.abs(start.y - end.y) }
}

/** Mount over the map's exact CSS bounds. The overlay consumes drawing gestures. */
export function CaptureSelection({ onSelected, onCancel }: CaptureSelectionProps) {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: number, start: Point } | null>(null)
  const [region, setRegion] = useState<CaptureRegion | null>(null)
  const [notice, setNotice] = useState('Drag a rectangle to choose the screenshot area.')
  useEffect(() => {
    const previous = document.activeElement
    ref.current?.focus({ preventScroll: true })
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }) }
  }, [])

  const point = (event: PointerEvent<HTMLDivElement>): Point => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return { x: Math.max(0, Math.min(bounds.width, event.clientX - bounds.left)), y: Math.max(0, Math.min(bounds.height, event.clientY - bounds.top)) }
  }

  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    const origin = point(event)
    drag.current = { id: event.pointerId, start: origin }
    setRegion(rectangle(origin, origin))
    setNotice('Release to use this area. Escape cancels.')
  }

  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    setRegion(rectangle(drag.current.start, point(event)))
  }

  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    const chosen = rectangle(drag.current.start, point(event))
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (chosen.width < 48 || chosen.height < 48) {
      setRegion(null)
      setNotice('Choose an area at least 48 × 48 pixels, or use the full map.')
      return
    }
    onSelected(chosen)
  }

  return <div
    ref={ref}
    className="capture-selection"
    role="dialog"
    aria-modal="true"
    aria-label="Select screenshot area"
    aria-describedby="capture-selection-description"
    tabIndex={-1}
    onPointerDown={start}
    onPointerMove={move}
    onPointerUp={finish}
    onPointerCancel={() => { drag.current = null; setRegion(null) }}
    onContextMenu={(event) => { event.preventDefault(); event.stopPropagation() }}
    onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel() }
      if (event.key === 'Tab') {
        const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
        const first = buttons[0], last = buttons[buttons.length - 1]
        if (!first || !last) return
        if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
          event.preventDefault(); last.focus()
        } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) {
          event.preventDefault(); first.focus()
        }
      }
    }}
  >
    <div className="capture-selection-controls" onPointerDown={(event) => event.stopPropagation()}>
      <CropIcon size={18} aria-hidden="true" />
      <p id="capture-selection-description" aria-live="polite">{notice}</p>
      <Button type="button" variant="outline" size="sm" onClick={() => {
        if (ref.current) onSelected({ x: 0, y: 0, width: ref.current.clientWidth, height: ref.current.clientHeight })
      }}>Full map</Button>
      <Button type="button" variant="ghost" size="icon-sm" className="capture-selection-cancel" aria-label="Cancel screenshot selection" onClick={onCancel}><XIcon size={16} /></Button>
    </div>
    {region && <div className="capture-selection-rectangle" style={{ left: region.x, top: region.y, width: region.width, height: region.height }}>
      {region.width >= 48 && region.height >= 48 && <output className="capture-selection-size">{Math.round(region.width)} × {Math.round(region.height)}</output>}
    </div>}
  </div>
}
