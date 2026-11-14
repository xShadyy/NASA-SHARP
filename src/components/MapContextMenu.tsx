import { useId, type RefObject } from 'react'
import {
  BookmarkSimpleIcon,
  CameraIcon,
  PaletteIcon,
  PencilSimpleIcon,
  TrashIcon,
} from '@phosphor-icons/react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { formatCoordinates } from '@/lib/locations'
import {
  MEASUREMENT_COLORS,
  isMeasurementColor,
  type MeasurementColor,
} from '@/map/measurement-colors'
import type { MeasurementTarget } from '@/map/measurement-controller'
import './MapContextMenu.css'

type MapContextMenuProps = {
  triggerRef: RefObject<HTMLSpanElement | null>
  coordinates: [number, number] | null
  measurement: MeasurementTarget | null
  onDeleteMeasurement: () => void
  onRenameMeasurement: () => void
  onMeasurementColorChange: (color: MeasurementColor) => void
  onSave: () => void
  onCapture: () => void
}

export function MapContextMenu({
  triggerRef,
  coordinates,
  measurement,
  onDeleteMeasurement,
  onRenameMeasurement,
  onMeasurementColorChange,
  onSave,
  onCapture,
}: MapContextMenuProps) {
  const measurementLabelId = useId()
  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger
        ref={triggerRef}
        className="map-context-trigger"
        aria-hidden="true"
        tabIndex={-1}
      />
      <ContextMenuContent
        aria-label="Map actions"
        aria-describedby={measurement ? measurementLabelId : undefined}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <ContextMenuLabel>
          {coordinates ? formatCoordinates(coordinates) : 'Outside Earth'}
        </ContextMenuLabel>
        {measurement && (
          <>
            <ContextMenuLabel id={measurementLabelId} className="map-context-measurement-label">
              <strong>
                {measurement.name || (measurement.mode === 'area' ? 'Area' : 'Distance')}
              </strong>
              <span>{measurement.text}</span>
            </ContextMenuLabel>
            <ContextMenuItem onSelect={onRenameMeasurement}>
              <PencilSimpleIcon size={16} />
              Rename measurement.
            </ContextMenuItem>
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <PaletteIcon size={16} />
                Change color
              </ContextMenuSubTrigger>
              <ContextMenuSubContent aria-label="Measurement color">
                <ContextMenuRadioGroup
                  value={measurement.color}
                  onValueChange={(color) => {
                    if (isMeasurementColor(color)) onMeasurementColorChange(color)
                  }}
                  aria-label="Measurement color"
                >
                  {MEASUREMENT_COLORS.map((color) => (
                    <ContextMenuRadioItem key={color.id} value={color.id}>
                      <span
                        className="map-context-color-swatch"
                        style={{ backgroundColor: color.value }}
                        aria-hidden="true"
                      />
                      {color.label}
                    </ContextMenuRadioItem>
                  ))}
                </ContextMenuRadioGroup>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuItem onSelect={onDeleteMeasurement}>
              <TrashIcon size={16} />
              Delete measurement
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem disabled={!coordinates} onSelect={onSave}>
          <BookmarkSimpleIcon size={16} />
          Save this location.
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onCapture}>
          <CameraIcon size={16} />
          Screenshot selection.
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
