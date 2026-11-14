import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Marker, type Map as MapLibreMap } from 'maplibre-gl'
import { BookmarkSimpleIcon, CheckIcon, XIcon } from '@phosphor-icons/react'
import { LocationSymbol } from '@/components/LocationSymbol'
import { Button } from '@/components/ui/button'
import { formatCoordinates, type LocationTarget } from '@/lib/locations'
import './LocationPin.css'

type LocationPinProps = {
  map: MapLibreMap
  location: LocationTarget
  saved: boolean
  onSave: (location: LocationTarget) => void
  onDismiss: () => void
}

/** A coordinate-anchored MapLibre marker; React supplies its accessible controls. */
export function LocationPin({ map, location, saved, onSave, onDismiss }: LocationPinProps) {
  const [element] = useState(() => {
    const node = document.createElement('div')
    node.className = 'destination-marker'
    return node
  })
  const [longitude, latitude] = location.coordinates
  const dismissPin = useCallback(
    (restoreMapFocus = false) => {
      // A dismissed card must not leave keyboard focus on a removed button.
      // Preserve focus elsewhere, including search and sidebar controls.
      if (restoreMapFocus || element.contains(element.ownerDocument.activeElement)) {
        map.getCanvas().focus({ preventScroll: true })
      }
      onDismiss()
    },
    [element, map, onDismiss],
  )

  useEffect(() => {
    const ownerWindow = element.ownerDocument.defaultView
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.repeat || event.isComposing)
        return
      const target = event.target
      // Radix consumes Escape in document capture, and tool panels consume it
      // while bubbling. Search blurs its input before this listener runs, so
      // inspect the original event target instead of the new active element.
      if (
        target instanceof Element &&
        target.closest(
          '.destination-search, [role="dialog"], [role="menu"], [role="listbox"], [data-slot="popover-content"], [data-slot="select-content"]',
        )
      )
        return
      event.preventDefault()
      dismissPin()
    }
    ownerWindow?.addEventListener('keydown', onKeyDown)
    return () => ownerWindow?.removeEventListener('keydown', onKeyDown)
  }, [dismissPin, element])

  useEffect(() => {
    const marker = new Marker({ element, anchor: 'bottom', opacityWhenCovered: 0 })
      .setLngLat([longitude, latitude])
      .addTo(map)
    const initialZoom = map.getZoom()
    const card = element.querySelector<HTMLElement>('.destination-pin-card')
    const keepCardVisible = () => {
      const hidden = map.getZoom() < initialZoom - 1
      if (hidden && element.contains(element.ownerDocument.activeElement)) {
        map.getCanvas().focus({ preventScroll: true })
      }
      element.toggleAttribute('data-zoom-hidden', hidden)
      if (!card || hidden) return
      const container = map.getContainer().getBoundingClientRect()
      const pin = element.getBoundingClientRect()
      const pinCenter = pin.left + pin.width / 2 - container.left
      const halfWidth = card.offsetWidth / 2
      const center = Math.max(halfWidth + 12, Math.min(container.width - halfWidth - 12, pinCenter))
      card.style.setProperty('--pin-card-offset-x', `${center - pinCenter}px`)
      const roomBelow = container.bottom - pin.bottom
      card.dataset.side =
        roomBelow < card.offsetHeight + 12 && pin.top - container.top > card.offsetHeight + 12
          ? 'above'
          : 'below'
    }
    keepCardVisible()
    map.on('move', keepCardVisible)
    map.on('resize', keepCardVisible)
    const observer = new ResizeObserver(keepCardVisible)
    if (card) observer.observe(card)
    const stop = (event: Event) => event.stopPropagation()
    const events = [
      'pointerdown',
      'mousedown',
      'click',
      'dblclick',
      'contextmenu',
      'touchstart',
      'touchend',
      'wheel',
    ]
    events.forEach((event) => element.addEventListener(event, stop))
    return () => {
      events.forEach((event) => element.removeEventListener(event, stop))
      map.off('move', keepCardVisible)
      map.off('resize', keepCardVisible)
      observer.disconnect()
      marker.remove()
    }
  }, [map, element, longitude, latitude])

  return createPortal(
    <>
      <LocationSymbol
        icon={location.icon}
        color={location.color}
        className="destination-pin-symbol"
        size={36}
      />
      <section
        className="destination-pin-card"
        aria-label={`Destination: ${location.name}`}
        aria-keyshortcuts="Escape"
      >
        <div className="destination-pin-title">
          <strong>{location.name}</strong>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="destination-pin-close"
            aria-label="Dismiss location pin"
            onClick={() => dismissPin(true)}
          >
            <XIcon size={14} />
          </Button>
        </div>
        <span className="destination-pin-coordinate-label">Latitude / longitude</span>
        <div className="destination-pin-coordinate-line">
          <output className="destination-pin-coordinates">
            {formatCoordinates(location.coordinates)}
          </output>
          {location.country && (
            <span className="destination-pin-country"> · {location.country}</span>
          )}
        </div>
        {location.accuracy !== undefined && (
          <span className="destination-pin-detail">
            Browser accuracy: ±{Math.round(location.accuracy).toLocaleString()} m
          </span>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="destination-pin-save"
          disabled={saved}
          aria-label={saved ? `${location.name} is saved` : `Save ${location.name}`}
          onClick={() => onSave(location)}
        >
          {saved ? <CheckIcon size={15} /> : <BookmarkSimpleIcon size={15} />}
          {saved ? 'Saved' : 'Save location'}
        </Button>
      </section>
    </>,
    element,
  )
}
