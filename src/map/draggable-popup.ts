import type { Map as MapLibreMap, Popup } from 'maplibre-gl'

export function clampPopupOffset(
  rect: { left: number; top: number; width: number; height: number },
  viewport: { left: number; top: number; width: number; height: number },
  offset: { x: number; y: number },
  margin = 10,
) {
  const horizontal = Math.min(margin, viewport.width / 4)
  const vertical = Math.min(margin, viewport.height / 4)
  const minimumX = viewport.left + horizontal - rect.left + offset.x
  const maximumX = viewport.left + viewport.width - horizontal - rect.width - rect.left + offset.x
  const minimumY = viewport.top + vertical - rect.top + offset.y
  const maximumY = viewport.top + viewport.height - vertical - rect.height - rect.top + offset.y
  return {
    x: Math.max(minimumX, Math.min(offset.x, Math.max(minimumX, maximumX))),
    y: Math.max(minimumY, Math.min(offset.y, Math.max(minimumY, maximumY))),
  }
}

/** Drag only the heading; text, native controls and the map retain their own gestures. */
export function createDraggablePopup(popup: Popup, map: MapLibreMap) {
  let content: HTMLElement | null = null
  let offset = { x: 0, y: 0 }
  let drag: { x: number; y: number; offsetX: number; offsetY: number; pointer: number } | null =
    null
  let frame = 0
  let destroyed = false
  const observer =
    typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => schedule())
  function clamp() {
    frame = 0
    if (destroyed || !content || !popup.isOpen()) return
    const viewport = map.getContainer().getBoundingClientRect()
    content.style.maxHeight = `${Math.max(120, viewport.height - 20)}px`
    content.style.setProperty(
      '--popup-content-max-height',
      `${Math.max(80, viewport.height - 50)}px`,
    )
    content.style.maxWidth = `${Math.max(120, viewport.width - 20)}px`
    offset = clampPopupOffset(content.getBoundingClientRect(), viewport, offset)
    content.style.translate = `${offset.x}px ${offset.y}px`
    const outer = popup.getElement()
    outer.classList.toggle('fire-popup-dragged', offset.x !== 0 || offset.y !== 0)
  }
  function schedule() {
    if (!destroyed && !frame && typeof requestAnimationFrame === 'function')
      frame = requestAnimationFrame(clamp)
  }
  function down(event: PointerEvent) {
    if (
      event.button !== 0 ||
      !(event.target instanceof Element) ||
      !event.target.closest('.fire-popup-drag-handle, .fire-popup > strong')
    )
      return
    if (!content) return
    event.preventDefault()
    event.stopPropagation()
    drag = {
      x: event.clientX,
      y: event.clientY,
      offsetX: offset.x,
      offsetY: offset.y,
      pointer: event.pointerId,
    }
    content.setPointerCapture(event.pointerId)
    content.classList.add('is-dragging')
  }
  function move(event: PointerEvent) {
    if (!drag || !content) return
    event.preventDefault()
    event.stopPropagation()
    offset = { x: drag.offsetX + event.clientX - drag.x, y: drag.offsetY + event.clientY - drag.y }
    content.style.translate = `${offset.x}px ${offset.y}px`
    clamp()
  }
  function up() {
    drag = null
    content?.classList.remove('is-dragging')
  }
  function detach() {
    observer?.disconnect()
    content?.removeEventListener('pointerdown', down)
    content?.removeEventListener('pointermove', move)
    content?.removeEventListener('pointerup', up)
    content?.removeEventListener('lostpointercapture', up)
    content = null
    drag = null
  }
  function refresh() {
    if (
      destroyed ||
      !popup.isOpen() ||
      typeof popup.getElement !== 'function' ||
      typeof map.getContainer !== 'function'
    )
      return
    const next = popup.getElement().querySelector<HTMLElement>('.maplibregl-popup-content')
    if (next !== content) {
      detach()
      content = next
      content?.addEventListener('pointerdown', down)
      content?.addEventListener('pointermove', move)
      content?.addEventListener('pointerup', up)
      content?.addEventListener('lostpointercapture', up)
      if (content) observer?.observe(content)
    }
    schedule()
  }
  function close() {
    detach()
    offset = { x: 0, y: 0 }
  }
  popup.on('open', refresh)
  popup.on('close', close)
  map.on('moveend', schedule)
  map.on('resize', schedule)
  return {
    refresh,
    destroy() {
      destroyed = true
      if (frame) cancelAnimationFrame(frame)
      detach()
      popup.off('open', refresh)
      popup.off('close', close)
      map.off('moveend', schedule)
      map.off('resize', schedule)
    },
  }
}
