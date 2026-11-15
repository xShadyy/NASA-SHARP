import assert from 'node:assert/strict'
import test from 'node:test'
import {
  aggregateDailyActivity,
  aggregateHourlyActivity,
  confidenceBuckets,
  compareActivity,
  filterDetections,
  detectionsToCsv,
  frpBuckets,
  getAreaAnalyticsWindows,
  highestFrp,
  latestDetection,
  medianFrp,
  peakActivity,
  topDetectionCells,
  type HotspotDetection,
} from '../src/lib/area-analytics'

function detection(acquiredAt: string, longitude = -120, satellite = 'N') {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [longitude, 35] },
    properties: {
      source: 'VIIRS_NOAA20_NRT',
      sensor: 'VIIRS',
      satellite,
      processing: 'NRT',
      acquired_at: acquiredAt,
      confidence: 'n',
      confidence_scale: 'low/nominal/high',
      confidence_class: 'nominal',
      frp_mw: 12.5,
      brightness_k: null,
      daynight: 'D',
    },
  } satisfies HotspotDetection
}

test('builds current and immediately preceding UTC windows', () => {
  assert.deepEqual(getAreaAnalyticsWindows(3, '2026-03-01'), {
    currentStart: '2026-02-27',
    previousStart: '2026-02-24',
    endDate: '2026-03-01',
  })
})

test('rejects live intervals outside the supported slider range', () => {
  assert.throws(() => getAreaAnalyticsWindows(31, '2026-03-01'), RangeError)
  assert.throws(() => getAreaAnalyticsWindows(0, '2026-03-01'), RangeError)
})

test('aggregates detections into complete daily bins including empty days', () => {
  const bins = aggregateDailyActivity(
    [
      detection('2026-03-01T04:30:00Z'),
      detection('2026-03-01T20:30:00Z'),
      detection('2026-03-03T02:00:00Z'),
      detection('2026-03-04T00:00:00Z'),
    ],
    '2026-03-01',
    3,
  )
  assert.deepEqual(bins, [
    { date: '2026-03-01', count: 2 },
    { date: '2026-03-02', count: 0 },
    { date: '2026-03-03', count: 1 },
  ])
  assert.deepEqual(peakActivity(bins), { date: '2026-03-01', count: 2 })
})

test('returns no peak for a period with no detections', () => {
  assert.equal(peakActivity([{ date: '2026-03-01', count: 0 }]), null)
})

test('compares periods and handles a zero comparison baseline', () => {
  assert.deepEqual(compareActivity(15, 10), { difference: 5, percentage: 50 })
  assert.deepEqual(compareActivity(0, 10), { difference: -10, percentage: -100 })
  assert.deepEqual(compareActivity(8, 0), { difference: 8, percentage: null })
})

test('aggregates operational breakdowns without merging sensor confidence scales', () => {
  const viirs = detection('2026-03-01T04:30:00Z')
  const modis = {
    ...detection('2026-03-02T18:30:00Z', 20),
    properties: {
      ...detection('2026-03-02T18:30:00Z', 20).properties,
      source: 'MODIS_NRT',
      sensor: 'MODIS',
      confidence: 90,
      confidence_scale: '0-100',
      confidence_class: null,
      frp_mw: 50,
      daynight: 'N',
    },
  } satisfies HotspotDetection
  assert.deepEqual(
    aggregateHourlyActivity([viirs, modis]).filter(({ count }) => count > 0),
    [
      { hour: 4, count: 1 },
      { hour: 18, count: 1 },
    ],
  )
  assert.deepEqual(confidenceBuckets([viirs, modis]), [
    { label: 'VIIRS N', count: 1 },
    { label: 'MODIS 80-100', count: 1 },
  ])
  assert.deepEqual(frpBuckets([viirs, modis]).slice(0, 3), [
    { label: '0-10 MW', count: 0 },
    { label: '10-50 MW', count: 1 },
    { label: '50-100 MW', count: 1 },
  ])
  assert.equal(medianFrp([viirs, modis]), 31.25)
  assert.deepEqual(filterDetections([viirs, modis], 'MODIS', 'night'), [modis])
})

test('finds the newest and highest-FRP observations and ranks spatial grid cells', () => {
  const first = detection('2026-03-01T04:30:00Z', -120)
  const sameCell = detection('2026-03-01T08:30:00Z', -119)
  const otherCell = detection('2026-03-02T08:30:00Z', 20)
  const strongest = {
    ...otherCell,
    properties: { ...otherCell.properties, frp_mw: 200 },
  } satisfies HotspotDetection
  assert.equal(latestDetection([first, otherCell]), otherCell)
  assert.equal(highestFrp([first, strongest]), strongest)
  assert.deepEqual(
    topDetectionCells([first, sameCell, otherCell]).map(({ count }) => count),
    [2, 1],
  )
  assert.throws(() => topDetectionCells([first], 0), RangeError)
})

test('exports quoted CSV cells with source and confidence provenance', () => {
  const csv = detectionsToCsv([detection('2026-03-01T04:30:00Z', -120, 'Satellite "N"')])
  assert.match(csv, /acquired_at_utc,longitude,latitude,sensor/)
  assert.match(csv, /"Satellite ""N"""/)
  assert.match(csv, /"VIIRS_NOAA20_NRT"/)
  assert.match(csv, /"low\/nominal\/high"/)
  assert.match(csv, /"12.5"/)
})
