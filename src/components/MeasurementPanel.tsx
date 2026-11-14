import { ArrowUUpLeftIcon, RulerIcon, PolygonIcon, TrashIcon } from '@phosphor-icons/react'
import type { RefObject } from 'react'
import { DraggablePanel } from '@/components/DraggablePanel'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  measurementUnits,
  type MeasurementMode,
  type MeasurementUnit,
} from '@/lib/measurement-units'
import {
  MEASUREMENT_COLORS,
  isMeasurementColor,
  measurementColorValue,
  type MeasurementColor,
} from '@/map/measurement-colors'
import './MeasurementPanel.css'

type MeasurementPanelProps = {
  containerRef: RefObject<HTMLElement | null>
  mode: MeasurementMode
  unit: MeasurementUnit
  color: MeasurementColor
  canUndo: boolean
  canClear?: boolean
  canFinish?: boolean
  onUndo?: () => void
  onFinish?: () => void
  onModeChange: (mode: 'orbit' | MeasurementMode) => void
  onUnitChange: (unit: MeasurementUnit) => void
  onColorChange: (color: MeasurementColor) => void
  onClose: () => void
  onClear?: () => void
}

const units = Object.entries(measurementUnits) as [
  MeasurementUnit,
  (typeof measurementUnits)[MeasurementUnit],
][]

export function MeasurementPanel({
  containerRef,
  mode,
  unit,
  color,
  canUndo,
  canClear = canUndo,
  canFinish = false,
  onUndo,
  onFinish,
  onModeChange,
  onUnitChange,
  onColorChange,
  onClose,
  onClear,
}: MeasurementPanelProps) {
  return (
    <DraggablePanel
      id="measurement-panel"
      title="MEASURE TOOLS"
      onClose={onClose}
      containerRef={containerRef}
      className="measurement-panel"
      initialPlacement="left-center"
    >
      <div className="measurement-controls">
        <ToggleGroup
          type="single"
          value={mode}
          aria-label="Measurement tool"
          className="measurement-modes"
          onValueChange={(value) => {
            if (value === 'area' || value === 'ruler') onModeChange(value)
          }}
        >
          <ToggleGroupItem value="area" aria-label="Area" className="measurement-tool">
            <PolygonIcon size={17} aria-hidden="true" />
            <span>Area</span>
          </ToggleGroupItem>
          <ToggleGroupItem value="ruler" aria-label="Distance" className="measurement-tool">
            <RulerIcon size={17} aria-hidden="true" />
            <span>Distance</span>
          </ToggleGroupItem>
        </ToggleGroup>
        <div className="measurement-actions">
          <Button
            type="button"
            variant="ghost"
            aria-label="Undo"
            className="measurement-tool"
            onClick={onUndo}
            disabled={!canUndo || !onUndo}
          >
            <ArrowUUpLeftIcon size={17} aria-hidden="true" />
            <span>Undo</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            aria-label="Clear"
            className="measurement-tool"
            onClick={onClear}
            disabled={!canClear || !onClear}
          >
            <TrashIcon size={17} aria-hidden="true" />
            <span>Clear</span>
          </Button>
        </div>
        <div className="measurement-unit-control">
          <label className="measurement-unit-label" htmlFor="measurement-unit-select">
            Units
          </label>
          <Select value={unit} onValueChange={(value) => onUnitChange(value as MeasurementUnit)}>
            <SelectTrigger id="measurement-unit-select" className="measurement-unit-trigger">
              <SelectValue>{measurementUnits[unit].symbol}</SelectValue>
            </SelectTrigger>
            <SelectContent
              position="popper"
              side="bottom"
              align="end"
              avoidCollisions={false}
              className="measurement-units-popover"
            >
              {units.map(([value, option]) => (
                <SelectItem key={value} value={value} className="measurement-units-option">
                  {option.label} [{option.symbol}]
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {onFinish && (
            <Button
              type="button"
              variant="outline"
              className="measurement-finish"
              disabled={!canFinish}
              onClick={onFinish}
              title="Finish the measurement (Enter, double-click or right-click on the map)"
            >
              Finish
            </Button>
          )}
        </div>
      </div>
      <div className="measurement-color-control">
        <label htmlFor="measurement-color-select">Line color</label>
        <Select
          value={color}
          onValueChange={(value) => {
            if (isMeasurementColor(value)) onColorChange(value)
          }}
        >
          <SelectTrigger id="measurement-color-select" className="measurement-color-trigger">
            <SelectValue>
              <span className="measurement-color-value">
                <span
                  className="measurement-color-swatch"
                  style={{ backgroundColor: measurementColorValue(color) }}
                  aria-hidden="true"
                />
                {MEASUREMENT_COLORS.find((option) => option.id === color)!.label}
              </span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent
            position="popper"
            side="bottom"
            align="end"
            avoidCollisions={false}
            className="measurement-colors-popover"
          >
            {MEASUREMENT_COLORS.map((option) => (
              <SelectItem key={option.id} value={option.id} className="measurement-color-option">
                <span className="measurement-color-value">
                  <span
                    className="measurement-color-swatch"
                    style={{ backgroundColor: option.value }}
                    aria-hidden="true"
                  />
                  {option.label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </DraggablePanel>
  )
}
