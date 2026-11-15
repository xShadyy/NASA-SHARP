import { firePlatformLabel, formatFireTime, type FireFeature } from '@/lib/fire-severity'
import {
  emptyObservationFilters,
  nativeConfidence,
  observationGroup,
  queryObservationSelection,
  type ObservationSelectionFilters,
} from '@/lib/observation-selection'
import type { FireInvestigationSelection } from './fire-dots'

export type FrozenObservationSelection = {
  members: FireFeature[]
  query?: unknown
  sourceGeneration?: string
  queryIdentity?: string
  selectionToken?: string
}

export function createObservationPopup(options: {
  anchor: [number, number]
  selection: FrozenObservationSelection
  onInspect: (feature: FireFeature, matching: FireFeature[]) => void
  onZoom: (matching: FireFeature[]) => void
  onOpenAnalytics?: (selection: FireInvestigationSelection) => void
}) {
  const root = document.createElement('div')
  root.className = 'fire-popup fire-popup-group'
  const selection = options.selection
  let filters = emptyObservationFilters()
  let offset = 0
  let pageSize = 10

  function field(parent: HTMLElement, name: string, value: string) {
    const p = document.createElement('p')
    const strong = document.createElement('strong')
    strong.textContent = name + ': '
    p.append(strong, document.createTextNode(value))
    parent.append(p)
  }

  function control(parent: HTMLElement, name: string, input: HTMLElement) {
    const label = document.createElement('label')
    label.className = 'fire-popup-control'
    const caption = document.createElement('span')
    caption.textContent = name
    label.append(caption, input)
    parent.append(label)
  }

  function select(
    parent: HTMLElement,
    name: string,
    key: keyof ObservationSelectionFilters,
    values: [string, string][],
  ) {
    const input = document.createElement('select')
    for (const [value, text] of values) {
      const item = document.createElement('option')
      item.value = value
      item.textContent = text
      input.append(item)
    }
    input.value = filters[key]
    input.addEventListener('change', () => {
      Object.assign(filters, { [key]: input.value })
      offset = 0
      render()
    })
    control(parent, name, input)
  }

  function input(
    parent: HTMLElement,
    name: string,
    key: keyof ObservationSelectionFilters,
    type = 'text',
  ) {
    const element = document.createElement('input')
    element.type = type
    element.value = filters[key]
    element.addEventListener('change', () => {
      Object.assign(filters, { [key]: element.value })
      offset = 0
      render()
    })
    control(parent, name, element)
  }

  function action(parent: HTMLElement, text: string, fn: () => void, disabled = false) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = text
    button.disabled = disabled
    button.addEventListener('click', fn)
    parent.append(button)
  }

  function nativeOptions(): Record<string, unknown> {
    const [sensor, confidence] = filters.confidence.split(':')
    return {
      search: filters.search || undefined,
      platform: filters.platform || undefined,
      sensor: filters.sensor || sensor || undefined,
      dayNight: filters.dayNight || undefined,
      frpMin: filters.frpMin === '' ? undefined : Number(filters.frpMin),
      frpMax: filters.frpMax === '' ? undefined : Number(filters.frpMax),
      acquiredStart: filters.start ? new Date(filters.start + 'Z').toISOString() : undefined,
      acquiredEndExclusive: filters.end ? new Date(filters.end + 'Z').toISOString() : undefined,
      modisConfidenceMin:
        sensor === 'MODIS' && confidence !== 'unknown' ? Number(confidence) : undefined,
      modisConfidenceMax:
        sensor === 'MODIS' && confidence !== 'unknown' ? Number(confidence) : undefined,
      modisConfidenceUnknown: sensor === 'MODIS' && confidence === 'unknown' ? true : undefined,
      viirsConfidence: sensor === 'VIIRS' ? [confidence] : undefined,
      sort: filters.sort,
      groupBy: filters.groupBy,
    }
  }

  function download(format: 'csv' | 'geojson' | 'json') {
    const { matching } = queryObservationSelection(selection.members, filters)
    const fields = [
      'id',
      'acquiredAt',
      'longitude',
      'latitude',
      'platform',
      'sensor',
      'frpMw',
      'dayNight',
      'scanKm',
      'trackKm',
      'source',
      'processingTier',
      'productVersion',
    ]
    const escape = (value: unknown) => '"' + String(value ?? '').replaceAll('"', '""') + '"'
    const metadata = {
      query: selection.query,
      filters: nativeOptions(),
      selectionToken: selection.selectionToken,
      sourceGeneration: selection.sourceGeneration,
      queryIdentity: selection.queryIdentity,
      matchingCount: matching.length,
      selectedCount: selection.members.length,
      observationIds: matching.map((feature) => feature.properties.id),
      retrievedAt: new Date().toISOString(),
      methodVersion: 'afternoon-active-cells-2km-1',
      scope: 'Frozen display-aggregate observation membership',
      sources: [
        ...new Set(
          matching.map((feature) =>
            String(feature.properties.source ?? feature.properties.provenance ?? 'Unknown'),
          ),
        ),
      ],
    }
    const content =
      format === 'csv'
        ? [
            fields.join(','),
            ...matching.map((feature) =>
              fields.map((key) => escape(feature.properties[key])).join(','),
            ),
          ].join('\r\n')
        : JSON.stringify(
            format === 'geojson'
              ? { type: 'FeatureCollection', features: matching, metadata }
              : metadata,
            null,
            2,
          )
    const url = URL.createObjectURL(
      new Blob([content], {
        type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json',
      }),
    )
    const link = document.createElement('a')
    link.href = url
    link.download = 'sharp-observations.' + format
    link.click()
    URL.revokeObjectURL(url)
  }

  function render(message = '') {
    root.replaceChildren()
    const title = document.createElement('strong')
    title.className = 'fire-popup-drag-handle'
    title.textContent = 'Aggregated satellite hotspots'
    root.append(title)
    const { matching, counts } = queryObservationSelection(selection.members, filters)
    const summary = document.createElement('div')
    summary.className = 'fire-popup-summary'
    field(summary, 'Observations', matching.length + ' matching out of ' + selection.members.length)
    if (selection.members.length) {
      let earliest = Infinity,
        latest = -Infinity,
        maximum = -Infinity
      for (const feature of selection.members) {
        earliest = Math.min(earliest, feature.properties.acquiredEpoch)
        latest = Math.max(latest, feature.properties.acquiredEpoch)
        maximum = Math.max(maximum, feature.properties.frpMw ?? -Infinity)
      }
      field(
        summary,
        'Acquired UTC',
        formatFireTime(new Date(earliest).toISOString()) +
          ' – ' +
          formatFireTime(new Date(latest).toISOString()),
      )
      field(
        summary,
        'Satellites',
        [
          ...new Set(
            selection.members.map(
              (feature) => firePlatformLabel(feature.properties.platform) || 'Unknown',
            ),
          ),
        ].join(', '),
      )
      field(
        summary,
        'Maximum FRP',
        Number.isFinite(maximum) ? maximum.toFixed(1) + ' MW' : 'Unknown',
      )
    }
    if (message) field(summary, 'Status', message)
    root.append(summary)
    const controls = document.createElement('div')
    controls.className = 'fire-popup-controls'
    input(controls, 'Search ID, satellite or product', 'search', 'search')
    select(controls, 'Satellite', 'platform', [
      ['', 'All satellites'],
      ...[...new Set(selection.members.map((feature) => feature.properties.platform))]
        .sort()
        .map((value) => [value, firePlatformLabel(value) || 'Unknown'] as [string, string]),
    ])
    select(controls, 'Sensor', 'sensor', [
      ['', 'All sensors'],
      ...[...new Set(selection.members.map((feature) => feature.properties.sensor))]
        .sort()
        .map((value) => [value, value || 'Unknown'] as [string, string]),
    ])
    select(controls, 'Day / night', 'dayNight', [
      ['', 'All'],
      ['day', 'Day'],
      ['night', 'Night'],
      ['unknown', 'Unknown'],
    ])
    select(controls, 'Group by', 'groupBy', [
      ['none', 'None'],
      ['date', 'UTC date'],
      ['hour', 'UTC acquisition hour'],
      ['satellite', 'Satellite'],
    ])
    select(controls, 'Sort', 'sort', [
      ['newest', 'Newest acquisition first'],
      ['oldest', 'Oldest acquisition first'],
      ['frp', 'Highest reported FRP'],
    ])
    root.append(controls)
    const details = document.createElement('details')
    const heading = document.createElement('summary')
    heading.textContent = 'Time, FRP and native confidence'
    details.append(heading)
    const extra = document.createElement('div')
    extra.className = 'fire-popup-controls'
    input(extra, 'From UTC (inclusive)', 'start', 'datetime-local')
    input(extra, 'Until UTC (exclusive)', 'end', 'datetime-local')
    input(extra, 'Minimum FRP (MW)', 'frpMin', 'number')
    input(extra, 'Maximum FRP (MW)', 'frpMax', 'number')
    select(extra, 'Sensor-native confidence', 'confidence', [
      ['', 'All native values'],
      ...[
        ...new Set(
          selection.members.map(
            (feature) => feature.properties.sensor + ':' + nativeConfidence(feature).toLowerCase(),
          ),
        ),
      ]
        .sort()
        .map((value) => [value, value.replace(':', ': ')] as [string, string]),
    ])
    details.append(extra)
    root.append(details)
    const list = document.createElement('div')
    list.className = 'fire-popup-list'
    list.tabIndex = 0
    let previousGroup = ''
    const page = matching.slice(offset, offset + pageSize)
    for (const original of page) {
      const group = observationGroup(original, filters.groupBy)
      if (group && group !== previousGroup) {
        const groupTitle = document.createElement('strong')
        groupTitle.textContent = group + ' · ' + counts.get(group) + ' observations'
        list.append(groupTitle)
        previousGroup = group
      }
      action(
        list,
        formatFireTime(original.properties.acquiredAt) +
          ' / ' +
          firePlatformLabel(original.properties.platform) +
          ' / ' +
          (original.properties.frpMw === null
            ? 'Unknown FRP'
            : original.properties.frpMw.toFixed(1) + ' MW'),
        () => options.onInspect(original, matching),
      )
    }
    if (!page.length) list.textContent = message || 'No matching observations.'
    root.append(list)
    const pagination = document.createElement('div')
    pagination.className = 'fire-popup-actions'
    const navigation = document.createElement('div')
    navigation.className = 'fire-popup-pagination'
    field(
      navigation,
      'Page',
      matching.length
        ? offset + 1 + '–' + Math.min(matching.length, offset + pageSize) + ' of ' + matching.length
        : '0 of 0',
    )
    action(
      navigation,
      'Previous',
      () => {
        offset -= pageSize
        render()
      },
      offset === 0,
    )
    action(
      navigation,
      'Next',
      () => {
        offset += pageSize
        render()
      },
      offset + pageSize >= matching.length,
    )
    const pageSizeSelect = document.createElement('select')
    for (const size of [10, 25]) {
      const item = document.createElement('option')
      item.value = String(size)
      item.textContent = size + ' per page'
      pageSizeSelect.append(item)
    }
    pageSizeSelect.value = String(pageSize)
    pageSizeSelect.addEventListener('change', () => {
      pageSize = Number(pageSizeSelect.value)
      offset = 0
      render()
    })
    control(navigation, 'Page size', pageSizeSelect)
    pagination.append(navigation)
    const tools = document.createElement('div')
    tools.className = 'fire-popup-button-row'
    action(tools, 'Clear filters', () => {
      filters = emptyObservationFilters()
      offset = 0
      render()
    })
    action(tools, 'Zoom to observations', () => options.onZoom(matching), !matching.length)
    pagination.append(tools)
    const exports = document.createElement('div')
    exports.className = 'fire-popup-export-row'
    for (const format of ['csv', 'geojson', 'json'] as const)
      action(
        exports,
        format === 'json' ? 'Reproducibility JSON' : 'Export ' + format.toUpperCase(),
        () => download(format),
        !matching.length,
      )
    pagination.append(exports)
    if (options.onOpenAnalytics)
      action(
        pagination,
        'Open in Area Analytics',
        () =>
          options.onOpenAnalytics?.({
            selectionToken: selection.selectionToken,
            observationIds: selection.members.map((feature) => feature.properties.id),
            sourceGeneration: selection.sourceGeneration,
            queryIdentity: selection.queryIdentity,
            filters: nativeOptions(),
          }),
        !selection.members.length || (!!selection.query && !selection.selectionToken),
      )
    root.append(pagination)
  }
  return { root, anchor: options.anchor, render }
}
