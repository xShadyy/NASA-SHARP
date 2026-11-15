import assert from 'node:assert/strict'
import test from 'node:test'
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec'
import { ANALYSIS_AREA_COLOR, ANALYSIS_AREA_FILL_PAINT } from '../src/map/analysis-colors'

test('draft and confirmed AOI fills share a fixed map color while retaining their distinct opacity', () => {
  assert.equal(ANALYSIS_AREA_COLOR, '#0960e1')
  assert.equal(ANALYSIS_AREA_FILL_PAINT?.['fill-color'], '#0960e1')
  assert.deepEqual(ANALYSIS_AREA_FILL_PAINT?.['fill-opacity'], [
    'case',
    ['==', ['get', 'role'], 'candidate'],
    0.12,
    0.055,
  ])
  const errors = validateStyleMin({
    version: 8,
    sources: { area: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
    layers: [
      { id: 'analysis-area-fill', type: 'fill', source: 'area', paint: ANALYSIS_AREA_FILL_PAINT },
    ],
  })
  assert.deepEqual(
    errors.map((error) => error.message),
    [],
  )
})
