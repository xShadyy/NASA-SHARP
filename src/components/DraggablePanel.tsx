import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { XIcon } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import './DraggablePanel.css'

interface Position {
  x: number
  y: number
}

interface DragSession {
  pointerId: number
  clientX: number
  clientY: number
  origin: Position
  moved: boolean
}

interface DraggablePanelProps {
  id: string
  title: string
  children: ReactNode
  onClose: () => void
  containerRef: RefObject<HTMLElement | null>
  className?: string
  dragLabel?: string
  closeLabel?: string
  initialPlacement?: 'bottom-center' | 'top-right' | 'left-center' | 'center'
}

const EDGE_GAP = 12
const TOOLBAR_CLEARANCE = 80
const DRAG_THRESHOLD = 5


export function DraggablePanel({
  id,
  title,
  children,
  onClose,
  containerRef,
  className,
  dragLabel,
  closeLabel,
  initialPlacement = 'bottom-center',
}: DraggablePanelProps) {
  const panelRef = useRef<HTMLElement>(null)
  const dragHandleRef = useRef<HTMLButtonElement>(null)
  const positionRef = useRef<Position | null>(null)
  const dragRef = useRef<DragSession | null>(null)
  const [dragging, setDragging] = useState(false)
  const instructionsId = useId()
  const titleId = `${id}-title`

  const movePanel = useCallback(
    (requestedPosition?: Position) => {
      const panel = panelRef.current
      const container = containerRef.current
      if (!panel || !container) return

      const containerWidth = container.clientWidth
      const containerHeight = container.clientHeight
      const panelWidth = panel.offsetWidth
      const panelHeight = panel.offsetHeight
      const horizontalGap = Math.min(EDGE_GAP, Math.max(0, (containerWidth - panelWidth) / 2))
      const verticalGap = Math.min(EDGE_GAP, Math.max(0, (containerHeight - panelHeight) / 2))
      const nextPosition = requestedPosition ??
        positionRef.current ?? {
          x:
            initialPlacement === 'top-right'
              ? containerWidth - panelWidth - EDGE_GAP
              : initialPlacement === 'left-center'
                ? EDGE_GAP
                : (containerWidth - panelWidth) / 2,
          y:
            initialPlacement === 'top-right'
              ? EDGE_GAP
              : initialPlacement === 'left-center' || initialPlacement === 'center'
                ? (containerHeight - panelHeight) / 2
                : containerHeight - panelHeight - (containerWidth <= 540 ? 100 : TOOLBAR_CLEARANCE),
        }
      const position = {
        x: Math.max(
          horizontalGap,
          Math.min(nextPosition.x, containerWidth - panelWidth - horizontalGap),
        ),
        y: Math.max(
          verticalGap,
          Math.min(nextPosition.y, containerHeight - panelHeight - verticalGap),
        ),
      }

      positionRef.current = position
      panel.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`
      panel.style.visibility = 'visible'
    },
    [containerRef, initialPlacement],
  )

  useLayoutEffect(() => {
    const panel = panelRef.current
    const container = containerRef.current
    if (!panel || !container) return

    movePanel()
    dragHandleRef.current?.focus({ preventScroll: true })
    const dragHandle = dragHandleRef.current
    
    const preventTouchGesture = (event: TouchEvent) => event.preventDefault()
    dragHandle?.addEventListener('touchstart', preventTouchGesture, { passive: false })
    let resizeFrame: number | undefined
    const observer = new ResizeObserver(() => {
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(() => movePanel())
    })
    observer.observe(container)
    observer.observe(panel)

    return () => {
      observer.disconnect()
      dragHandle?.removeEventListener('touchstart', preventTouchGesture)
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
    }
  }, [containerRef, movePanel])

  const startDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return
    const origin = positionRef.current
    if (!origin) return

    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      origin,
      moved: false,
    }
  }

  const continueDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const deltaX = event.clientX - drag.clientX
    const deltaY = event.clientY - drag.clientY
    if (!drag.moved && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD) return

    if (!drag.moved) {
      drag.moved = true
      setDragging(true)
    }
    movePanel({ x: drag.origin.x + deltaX, y: drag.origin.y + deltaY })
  }

  const finishDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const moveWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    const position = positionRef.current
    if (!position) return
    const step = event.shiftKey ? 32 : 8
    const offsets: Record<string, Position> = {
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
    }
    const offset = offsets[event.key]
    if (!offset) return
    event.preventDefault()
    event.stopPropagation()
    movePanel({ x: position.x + offset.x, y: position.y + offset.y })
  }

  return (
    <section
      ref={panelRef}
      id={id}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      className={cn('draggable-panel', className)}
      data-dragging={dragging || undefined}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <header className="draggable-panel__header">
        <Button
          ref={dragHandleRef}
          type="button"
          variant="ghost"
          className="draggable-panel__drag-handle"
          aria-label={dragLabel ?? `Move ${title.toLowerCase()} window`}
          aria-describedby={instructionsId}
          onPointerDown={startDrag}
          onPointerMove={continueDrag}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
          onLostPointerCapture={finishDrag}
          onKeyDown={moveWithKeyboard}
        >
          <span id={titleId} className="draggable-panel__title">
            {title}
          </span>
          <span className="draggable-panel__grip" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="draggable-panel__close"
          aria-label={closeLabel ?? `Close ${title.toLowerCase()}`}
          onClick={onClose}
        >
          <XIcon size={16} aria-hidden="true" />
        </Button>
      </header>
      <Separator className="draggable-panel__divider" />
      <span id={instructionsId} className="sr-only">
        Drag to move, or use the arrow keys. Hold Shift to move further.
      </span>
      <div className="draggable-panel__content">{children}</div>
    </section>
  )
}

export default DraggablePanel
