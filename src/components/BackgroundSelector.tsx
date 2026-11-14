import { CheckIcon } from '@phosphor-icons/react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { MAP_BACKGROUND_OPTIONS, isMapBackground, type MapBackground } from '@/map/basemaps'
import './BackgroundSelector.css'

type BackgroundSelectorProps = {
  value: MapBackground
  onValueChange: (background: MapBackground) => void
  disabled?: boolean
  label?: string
}

export function BackgroundSelector({
  value,
  onValueChange,
  disabled = false,
  label = 'Base map',
}: BackgroundSelectorProps) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(next) => {
        if (isMapBackground(next)) onValueChange(next)
      }}
      orientation="vertical"
      aria-label={label}
      disabled={disabled}
      className="background-selector"
    >
      {MAP_BACKGROUND_OPTIONS.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          aria-label={option.label}
          title={option.description}
          className="background-selector-option"
        >
          <span className="background-selector-indicator" aria-hidden="true">
            {value === option.value && <CheckIcon size={11} weight="bold" />}
          </span>
          <span className="background-selector-name">{option.label}</span>
          <img
            className="background-selector-preview"
            src={`/map-previews/${option.value}.webp`}
            width={80}
            height={80}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
          />
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
