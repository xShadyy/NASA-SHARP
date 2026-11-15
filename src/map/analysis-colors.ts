import type { FillLayerSpecification } from 'maplibre-gl'

// Geographic selection colors are independent of the interface's light/dark accent.
export const ANALYSIS_AREA_COLOR = '#0960e1'
export const ANALYSIS_AREA_FILL_PAINT: FillLayerSpecification['paint'] = {
  'fill-color': ANALYSIS_AREA_COLOR,
  'fill-opacity': ['case', ['==', ['get', 'role'], 'candidate'], 0.12, 0.055],
}
