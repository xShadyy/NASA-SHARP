import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { canonicalGlobalFeature } from '../src/lib/global-tiles'
import {
  emptyObservationFilters,
  matchesObservationFilters,
  queryObservationSelection,
} from '../src/lib/observation-selection'

// Python canonical queries and SQLite global queries consume this same offline contract.
const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/observation-filter-parity.json', import.meta.url),
    'utf8',
  ).replace(/^\uFEFF/, ''),
)
const features = fixture.observations.map((row: Record<string, unknown>) =>
  canonicalGlobalFeature({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [row.longitude, row.latitude] },
    properties: { ...row, kind: 'observation' },
  }),
)

for (const item of fixture.cases)
  test(`shared filter contract: ${item.name}`, () => {
    const actual = features
      .filter((feature) => matchesObservationFilters(feature, item.options))
      .map((feature) => feature.properties.id)
      .sort()
    assert.deepEqual(actual, [...item.expectedIds].sort())
  })
for (const item of fixture.sortCases)
  test(`shared sorting contract: ${item.name}`, () => {
    const actual = queryObservationSelection(features, {
      ...emptyObservationFilters(),
      ...item.options,
    }).matching.map((feature) => feature.properties.id)
    assert.deepEqual(actual, item.expectedIds)
  })
