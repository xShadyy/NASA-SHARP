import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { DraggablePanel } from '@/components/DraggablePanel'
import { LocationAppearancePicker } from '@/components/LocationAppearancePicker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DEFAULT_LOCATION_APPEARANCE, type LocationAppearance } from '@/lib/location-appearance'
import { formatCoordinates, locationKey, type LocationTarget } from '@/lib/locations'
import './LocationNameDialog.css'

type LocationNameDialogProps = {
  location: LocationTarget | null
  title: string
  onSubmit: (name: string, appearance: LocationAppearance) => void
  onClose: () => void
}

function LocationNameForm({
  location,
  title,
  onSubmit,
  onClose,
  containerRef,
}: Omit<LocationNameDialogProps, 'location'> & {
  location: LocationTarget
  containerRef: RefObject<HTMLDivElement | null>
}) {
  const [name, setName] = useState(location.name)
  const [appearance, setAppearance] = useState<LocationAppearance>({
    icon: location.icon ?? DEFAULT_LOCATION_APPEARANCE.icon,
    color: location.color ?? DEFAULT_LOCATION_APPEARANCE.color,
  })
  const inputRef = useRef<HTMLInputElement>(null)
  const previousFocus = useRef(document.activeElement)
  const id = useId()

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true })
    inputRef.current?.select()
    const previous = previousFocus.current
    return () => {
      const target =
        previous instanceof HTMLElement && previous.isConnected
          ? previous
          : document.querySelector<HTMLElement>('.maplibregl-canvas')
      target?.focus({ preventScroll: true })
    }
  }, [])

  return (
    <DraggablePanel
      id={`${id}-location-dialog`}
      title={title}
      className="location-save-panel"
      containerRef={containerRef}
      onClose={onClose}
      closeLabel={`Close ${title.toLowerCase()}`}
      dragLabel={`Move ${title.toLowerCase()} window`}
      initialPlacement="center"
    >
      <p className="location-save-coordinates">
        {formatCoordinates(location.coordinates)}
        {location.country ? ` · ${location.country}` : ''}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (name.trim()) onSubmit(name.trim(), appearance)
        }}
      >
        <label htmlFor={id}>Location name</label>
        <div className="location-save-name">
          <LocationAppearancePicker value={appearance} onChange={setAppearance} />
          <Input
            ref={inputRef}
            id={id}
            name="location-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            autoComplete="off"
            required
          />
        </div>
        <div className="location-save-actions">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!name.trim()}>
            Save
          </Button>
        </div>
      </form>
    </DraggablePanel>
  )
}

export function LocationNameDialog(props: LocationNameDialogProps) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const containerRef = useMemo(() => ({ current: container }), [container])
  return props.location
    ? createPortal(
        <div ref={setContainer} className="location-dialog-layer">
          {container && (
            <LocationNameForm
              key={`${locationKey(props.location)}:${props.location.name}`}
              {...props}
              location={props.location}
              containerRef={containerRef}
            />
          )}
        </div>,
        document.body,
      )
    : null
}
