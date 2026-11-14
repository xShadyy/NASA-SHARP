import { useId } from 'react'
import { LocationSymbol } from '@/components/LocationSymbol'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { isLocationIcon, LOCATION_ICONS, type LocationAppearance } from '@/lib/location-appearance'
import { isMeasurementColor, MEASUREMENT_COLORS } from '@/map/measurement-colors'
import './LocationAppearancePicker.css'

export function LocationAppearancePicker({
  value,
  onChange,
}: {
  value: LocationAppearance
  onChange: (appearance: LocationAppearance) => void
}) {
  const id = useId()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="location-appearance-trigger"
          aria-label="Choose location icon and color"
        >
          <LocationSymbol {...value} size={23} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="location-appearance-picker"
        align="start"
        aria-label="Location appearance"
      >
        <span id={`${id}-icons`} className="location-appearance-label">
          Icon
        </span>
        <ToggleGroup
          type="single"
          value={value.icon}
          aria-labelledby={`${id}-icons`}
          className="location-icon-options"
          onValueChange={(icon) => {
            if (isLocationIcon(icon)) onChange({ ...value, icon })
          }}
        >
          {LOCATION_ICONS.map((option) => (
            <ToggleGroupItem
              key={option.id}
              value={option.id}
              aria-label={option.label}
              title={option.label}
            >
              <LocationSymbol icon={option.id} color={value.color} size={22} />
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <span id={`${id}-colors`} className="location-appearance-label">
          Color
        </span>
        <ToggleGroup
          type="single"
          value={value.color}
          aria-labelledby={`${id}-colors`}
          className="location-color-options"
          onValueChange={(color) => {
            if (isMeasurementColor(color)) onChange({ ...value, color })
          }}
        >
          {MEASUREMENT_COLORS.map((option) => (
            <ToggleGroupItem
              key={option.id}
              value={option.id}
              aria-label={option.label}
              title={option.label}
            >
              <span style={{ backgroundColor: option.value }} aria-hidden="true" />
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </PopoverContent>
    </Popover>
  )
}
