import {
  FireIcon,
  FlagIcon,
  HouseIcon,
  MapPinIcon,
  MountainsIcon,
  PlanetIcon,
  StarIcon,
  TreeIcon,
} from '@phosphor-icons/react'
import { DEFAULT_LOCATION_APPEARANCE, type LocationIcon } from '@/lib/location-appearance'
import { measurementColorValue, type MeasurementColor } from '@/map/measurement-colors'

const symbols = {
  pin: MapPinIcon,
  star: StarIcon,
  flag: FlagIcon,
  house: HouseIcon,
  mountain: MountainsIcon,
  tree: TreeIcon,
  fire: FireIcon,
  planet: PlanetIcon,
}

export function LocationSymbol({
  icon = DEFAULT_LOCATION_APPEARANCE.icon,
  color = DEFAULT_LOCATION_APPEARANCE.color,
  size = 20,
  className,
}: {
  icon?: LocationIcon
  color?: MeasurementColor
  size?: number
  className?: string
}) {
  const Icon = symbols[icon]
  return (
    <Icon
      size={size}
      weight="fill"
      className={className}
      style={{ color: measurementColorValue(color) }}
      aria-hidden="true"
    />
  )
}
