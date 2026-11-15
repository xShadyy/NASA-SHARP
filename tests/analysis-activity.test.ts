import assert from 'node:assert/strict'
import test from 'node:test'
import type { Polygon } from 'geojson'
import {
  activityStats,
  analysisQuery,
  calendarWeeks,
  clampRange,
  crossesDateline,
  monthSpan,
  rangePreset,
  rangeQuery,
  focusRange,
  type SeriesPoint,
} from '../src/lib/analysis-activity'

const polygon: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ],
  ],
}

test('presets use exact 24 hours and calendar-aware month lengths', () => {
  const now = new Date('2026-11-15T14:25:00.000Z')
  const hours = rangePreset('24h', now)
  assert.equal(hours.startAt, '2026-11-14T14:25:00.000Z')
  assert.equal(hours.endAt, now.toISOString())
  const midnight = rangePreset('24h', new Date('2026-11-15T00:00:00.000Z'))
  assert.equal(midnight.start, '2026-11-14')
  assert.equal(midnight.end, '2026-11-14')
  assert.deepEqual(rangeQuery('area', polygon, hours).interval, {
    start: hours.startAt,
    endExclusive: hours.endAt,
  })
  assert.equal(rangePreset('7d', now).start, '2026-11-09')
  assert.equal(rangePreset('month', now).start, '2026-10-17')
  assert.equal(rangePreset('month', new Date('2026-12-15T14:25:00Z')).start, '2026-11-15')
  assert.equal(rangePreset('month', new Date('2024-02-29T14:25:00Z')).start, '2024-02-01')
})

test('day focus preserves the chosen period and intersects partial day boundaries', () => {
  const range = rangePreset('24h', new Date('2026-11-15T14:25:00.000Z'))
  const first = focusRange(range, '2026-11-14')
  const last = focusRange(range, '2026-11-15')
  assert.equal(first.startAt, range.startAt)
  assert.equal(first.endAt, undefined)
  assert.equal(last.startAt, undefined)
  assert.equal(last.endAt, range.endAt)
  assert.equal(focusRange(range, null), range)
  assert.equal(focusRange(range, '2026-11-01'), range)
  assert.equal(range.start, '2026-11-14')
  assert.equal(range.end, '2026-11-15')
})

test('historical selections retain the scientific afternoon-platform method', () => {
  for (const [start, end] of [
    ['2000-11-01', '2000-11-02'],
    ['2012-01-01', '2012-01-20'],
    ['2026-11-01', '2026-11-02'],
  ]) {
    const query = analysisQuery('area', polygon, start, end)
    assert.deepEqual(query.filters.platforms, ['aqua', 'suomi-npp', 'noaa-20', 'noaa-21'])
    assert.equal(query.processingMode, 'harmonized')
  }
})

function point(date: string, platform: string, count: number, state = 'complete'): SeriesPoint {
  return { date, endDate: date, count, platform, state }
}

test('a calendar month stays inside the 31-day live window', () => {
  const november = monthSpan('2026-11')
  assert.equal(november.start, '2026-11-01')
  assert.equal(november.end, '2026-11-30')
  assert.equal(november.endExclusive, '2026-12-01')
  assert.equal(monthSpan('2026-12').endExclusive, '2027-01-01')
})

test('the heatmap weeks start on Sunday and include the trailing days', () => {
  const weeks = calendarWeeks('2026-11')
  assert.equal(weeks[0][0], '2026-11-01')
  assert.equal(weeks.at(-1)?.at(-1), '2026-12-05')
  assert.equal(
    weeks.every((week) => week.length === 7),
    true,
  )
})

test('click selects one day and a drag is clamped to 31 days', () => {
  assert.deepEqual(clampRange('2026-03-10', '2026-03-10'), {
    start: '2026-03-10',
    end: '2026-03-10',
  })
  assert.deepEqual(clampRange('2026-03-10', '2026-03-03'), {
    start: '2026-03-03',
    end: '2026-03-10',
  })
  assert.deepEqual(clampRange('2026-01-01', '2026-02-15'), {
    start: '2026-01-01',
    end: '2026-01-31',
  })
  assert.deepEqual(clampRange('2026-01-31', '2025-12-01'), {
    start: '2026-01-01',
    end: '2026-01-31',
  })
})

test('dateline bounds are refused before a worldwide query', () => {
  assert.equal(
    crossesDateline([
      [179, -18],
      [181, -16],
    ]),
    true,
  )
  assert.equal(
    crossesDateline([
      [-10, 35],
      [5, 44],
    ]),
    false,
  )
})

test('the analysis query asks for harmonized daily afternoon detections', () => {
  const query = analysisQuery('area-1', polygon, '2026-11-01', '2026-12-01')
  assert.equal(query.processingMode, 'harmonized')
  assert.equal(query.resolution, 'daily')
  assert.deepEqual(query.aoi.geometry, polygon)
  assert.deepEqual(query.interval, {
    start: '2026-11-01T00:00:00.000Z',
    endExclusive: '2026-12-01T00:00:00.000Z',
  })
  assert.deepEqual(query.filters.platforms, ['aqua', 'suomi-npp', 'noaa-20', 'noaa-21'])
})

test('selected days sum detections and keep median FRP for the whole loaded month', () => {
  const series = [
    point('2026-11-01', 'aqua', 2),
    point('2026-11-01', 'noaa-20', 1),
    point('2026-11-02', 'aqua', 3),
    point('2026-11-02', 'noaa-20', 3),
    point('2026-11-03', 'aqua', 0, 'unavailable'),
    point('2026-11-03', 'noaa-20', 0, 'unavailable'),
  ]
  const selected = activityStats(series, { start: '2026-11-01', end: '2026-11-02' }, 12.5, false)
  assert.equal(selected.detections, 9)
  assert.equal(selected.daysWithDetections, 2)
  assert.equal(selected.peakDate, '2026-11-02')
  assert.equal(selected.medianFrp, null)
  const month = activityStats(series, { start: '2026-11-01', end: '2026-11-03' }, 12.5, true)
  assert.equal(month.medianFrp, 12.5)
  assert.equal(month.detections, 9)
  const empty = activityStats(
    [point('2026-11-03', 'aqua', 0, 'unavailable')],
    { start: '2026-11-03', end: '2026-11-03' },
    null,
    true,
  )
  assert.equal(empty.detections, null)
  const tie = activityStats(
    [point('2026-11-01', 'aqua', 4), point('2026-11-02', 'aqua', 4)],
    { start: '2026-11-01', end: '2026-11-02' },
    null,
    false,
  )
  assert.equal(tie.peakDate, '2026-11-01')
})
