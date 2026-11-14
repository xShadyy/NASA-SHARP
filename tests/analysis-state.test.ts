import assert from 'node:assert/strict'
import test from 'node:test'
import { drawnArea } from '../src/lib/analysis-area'
import { analysisReducer, initialAnalysisState } from '../src/lib/analysis-state'

const original = drawnArea(
  {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 0],
      ],
    ],
  },
  'polygon',
  'original',
)
const replacement = drawnArea(
  {
    type: 'Polygon',
    coordinates: [
      [
        [10, 10],
        [12, 10],
        [12, 12],
        [10, 10],
      ],
    ],
  },
  'rectangle',
  'replacement',
)

test('a preview does not replace the confirmed area until confirmation', () => {
  let state = analysisReducer(initialAnalysisState, { type: 'preview', area: original })
  assert.equal(state.confirmed, null)
  state = analysisReducer(state, { type: 'confirm' })
  state = analysisReducer(state, { type: 'preview', area: replacement })
  assert.equal(state.confirmed?.id, 'original')
  assert.equal(state.draft?.id, 'replacement')
  state = analysisReducer(state, { type: 'cancel' })
  assert.equal(state.confirmed?.id, 'original')
  assert.equal(state.draft, null)
})

test('editing works on a copy and cancel preserves the original geometry', () => {
  const confirmed = analysisReducer(
    analysisReducer(initialAnalysisState, { type: 'preview', area: original }),
    { type: 'confirm' },
  )
  const editing = analysisReducer(confirmed, { type: 'edit' })
  assert.notEqual(editing.draft?.geometry, confirmed.confirmed?.geometry)
  const changed = analysisReducer(editing, {
    type: 'drawing',
    area: replacement,
    error: null,
    vertices: 4,
  })
  assert.deepEqual(analysisReducer(changed, { type: 'cancel' }).confirmed, original)
})

test('an invalid drawing stays editable and cannot be confirmed', () => {
  let state = analysisReducer(initialAnalysisState, { type: 'draw', tool: 'polygon' })
  state = analysisReducer(state, {
    type: 'finish',
    area: original,
    error: 'The boundary crosses itself.',
  })
  assert.equal(state.phase, 'editing')
  state = analysisReducer(state, { type: 'confirm' })
  assert.equal(state.confirmed, null)
  state = analysisReducer(state, { type: 'drawing', area: original, error: null, vertices: 3 })
  state = analysisReducer(state, { type: 'confirm' })
  assert.equal(state.confirmed?.id, 'original')
})

test('clear removes both draft and confirmed areas and stops drawing', () => {
  const confirmed = analysisReducer(
    analysisReducer(initialAnalysisState, { type: 'preview', area: original }),
    { type: 'confirm' },
  )
  const cleared = analysisReducer(analysisReducer(confirmed, { type: 'draw', tool: 'rectangle' }), {
    type: 'clear',
  })
  assert.equal(cleared.confirmed, null)
  assert.equal(cleared.draft, null)
  assert.equal(cleared.phase, 'idle')
  assert.equal(cleared.tool, null)
})

test('loading and a failed replacement retain the confirmed area and cannot confirm a partial country', () => {
  const confirmed = analysisReducer(
    analysisReducer(initialAnalysisState, { type: 'preview', area: original }),
    { type: 'confirm' },
  )
  const pending = analysisReducer(confirmed, {
    type: 'country-loading',
    country: { id: 'country:POL', name: 'Poland' },
  })
  assert.equal(pending.phase, 'loading')
  assert.equal(pending.pendingCountry?.name, 'Poland')
  assert.equal(pending.confirmed, original)
  assert.equal(analysisReducer(pending, { type: 'confirm' }).confirmed, original)
  const failed = analysisReducer(pending, { type: 'country-failure', error: 'Source unavailable' })
  assert.equal(failed.confirmed, original)
  assert.equal(failed.draft, null)
  assert.equal(failed.pendingCountry, null)
  assert.equal(failed.error, 'Source unavailable')
})

test('manual previews, canceling and clearing preserve the camera request while confirmation and fit are explicit', () => {
  const preview = analysisReducer(initialAnalysisState, { type: 'preview', area: original })
  assert.equal(preview.fitRequest, 0)
  const confirmed = analysisReducer(preview, { type: 'confirm' })
  assert.equal(confirmed.fitRequest, 1)
  const replacementPreview = analysisReducer(confirmed, { type: 'preview', area: replacement })
  assert.equal(replacementPreview.fitRequest, 1)
  const canceled = analysisReducer(replacementPreview, { type: 'cancel' })
  assert.equal(canceled.fitRequest, 1)
  const fitted = analysisReducer(canceled, { type: 'fit' })
  assert.equal(fitted.fitRequest, 2)
  const cleared = analysisReducer(fitted, { type: 'clear' })
  assert.equal(cleared.fitRequest, 2)
  assert.equal(analysisReducer(cleared, { type: 'fit' }).fitRequest, 2)
})

test('a country requires full source, separate display geometry and a boundary reference before confirmation', () => {
  const candidate = { ...original, id: 'country:POL', name: 'Poland', type: 'country' as const }
  const incomplete = analysisReducer(initialAnalysisState, { type: 'preview', area: candidate })
  assert.equal(analysisReducer(incomplete, { type: 'confirm' }).confirmed, null)
  const ready = {
    ...candidate,
    sourceGeometry: candidate.geometry,
    displayGeometry: structuredClone(candidate.geometry),
    displayBoundary: {
      type: 'MultiPolygon' as const,
      coordinates: [candidate.geometry.coordinates],
    },
    boundaryRef: 'geoBoundaries:6.0.0:POL:ADM0',
  }
  const confirmed = analysisReducer(
    analysisReducer(initialAnalysisState, { type: 'preview', area: ready }),
    { type: 'confirm' },
  )
  assert.equal(confirmed.confirmed?.geometry, candidate.geometry)
  assert.equal(confirmed.confirmed?.sourceGeometry, candidate.geometry)
  assert.notEqual(confirmed.confirmed?.displayGeometry, candidate.geometry)
  assert.equal(confirmed.confirmed?.boundaryRef, ready.boundaryRef)
})

test('selecting a resolved country requests a fit immediately and confirmation does not repeat it', () => {
  const geometry = original.geometry
  const country = {
    ...original,
    id: 'country:POL',
    name: 'Poland',
    type: 'country' as const,
    sourceGeometry: geometry,
    displayGeometry: structuredClone(geometry),
    displayBoundary:
      geometry.type === 'Polygon'
        ? { type: 'MultiPolygon' as const, coordinates: [geometry.coordinates] }
        : geometry,
    boundaryRef: 'gbOpen:6.0.0:POL:ADM0:pinned',
  }
  const preview = analysisReducer(initialAnalysisState, { type: 'preview', area: country })
  assert.equal(preview.fitRequest, 1)
  assert.equal(preview.confirmed, null)
  assert.equal(preview.draft, country)
  const confirmed = analysisReducer(preview, { type: 'confirm' })
  assert.equal(confirmed.fitRequest, 1)
  assert.equal(confirmed.confirmed, country)
  assert.equal(confirmed.draft, null)
})

test('a replacement country fits its own preview while cancellation and failure retain the previous AOI', () => {
  const country = {
    ...original,
    id: 'country:POL',
    name: 'Poland',
    type: 'country' as const,
    sourceGeometry: original.geometry,
    displayGeometry: structuredClone(original.geometry),
    displayBoundary: {
      type: 'MultiPolygon' as const,
      coordinates:
        original.geometry.type === 'Polygon'
          ? [original.geometry.coordinates]
          : original.geometry.coordinates,
    },
    boundaryRef: 'gbOpen:6.0.0:POL:ADM0:pinned',
  }
  const confirmed = analysisReducer(
    analysisReducer(initialAnalysisState, { type: 'preview', area: country }),
    { type: 'confirm' },
  )
  const loading = analysisReducer(confirmed, {
    type: 'country-loading',
    country: { id: 'country:FRA', name: 'France' },
  })
  assert.equal(loading.fitRequest, 1)
  assert.equal(loading.confirmed, country)
  const replacementCountry = {
    ...country,
    id: 'country:FRA',
    name: 'France',
    geometry: replacement.geometry,
    sourceGeometry: replacement.geometry,
    boundaryRef: 'gbOpen:6.0.0:FRA:ADM0:pinned',
  }
  const preview = analysisReducer(loading, { type: 'preview', area: replacementCountry })
  assert.equal(preview.fitRequest, 2)
  assert.equal(preview.confirmed, country)
  assert.equal(preview.draft, replacementCountry)
  const canceled = analysisReducer(preview, { type: 'cancel' })
  assert.equal(canceled.fitRequest, 2)
  assert.equal(canceled.confirmed, country)
  const failed = analysisReducer(loading, { type: 'country-failure', error: 'Offline' })
  assert.equal(failed.fitRequest, 1)
  assert.equal(failed.confirmed, country)
  const cleared = analysisReducer(preview, { type: 'clear' })
  assert.equal(cleared.fitRequest, 2)
  assert.equal(cleared.confirmed, null)
})
