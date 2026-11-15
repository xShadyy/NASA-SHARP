import { firePlatformLabel, formatFireTime, type FireFeature } from '@/lib/fire-severity'
import { canonicalGlobalFeature } from '@/lib/global-tiles'
import type { GlobalWindow } from '@/hooks/use-global-fires'
import { downloadBlob } from '@/lib/investigation'

type RecordRow = {
  id: string
  longitude: number
  latitude: number
  acquiredAt: string
  platform: string
  sensor: string
  frpMw: number | null
  dayNight: string
  confidence: { kind: string; value: unknown; unit?: string }
  scanKm: number | null
  trackKm: number | null
  provenance?: string
  sourceProduct?: string
  productVersion?: string
  processingTier?: string
  groupKey?: string
}
type Page = {
  data: {
    rows: RecordRow[]
    total: number
    page: number
    pageSize: number
    groups: { key: string; label: string; count: number }[]
    summary: {
      selectedCount: number
      matchingCount: number
      earliestAcquisition: string | null
      latestAcquisition: string | null
      platforms: string[]
      maxFrpMw: number | null
    }
  }
  meta: { completeness?: string; freshness?: string }
}

export function createGlobalObservationPopup(config: {
  snapshotId: string
  window: GlobalWindow
  aggregateId?: string
  observationId?: string
  onSelect: (feature: FireFeature | null) => void
  onZoom: () => void
}) {
  const root = document.createElement('section')
  root.className = 'fire-popup fire-popup-group'
  let page = 1,
    pageSize = 10,
    revision = 0,
    disposed = false
  let result: Page | null = null,
    selected: RecordRow | null = null,
    busy = false,
    error = ''
  let pending: AbortController | null = null
  let filters: Record<string, unknown> = { sort: 'newest', groupBy: 'none' }
  function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '') {
    const element = document.createElement(tag)
    element.className = className
    return element
  }
  function field(parent: HTMLElement, label: string, value: unknown) {
    const row = node('p')
    const name = node('strong')
    name.textContent = `${label}: `
    row.append(name, document.createTextNode(value == null ? 'Unknown' : String(value)))
    parent.append(row)
  }
  function action(parent: HTMLElement, text: string, callback: () => void, disabled = false) {
    const element = node('button')
    element.type = 'button'
    element.textContent = text
    element.disabled = disabled
    element.addEventListener('click', callback)
    parent.append(element)
  }
  function control(parent: HTMLElement, label: string, element: HTMLElement) {
    const wrapper = node('label', 'fire-popup-control')
    const caption = node('span')
    caption.textContent = label
    wrapper.append(caption, element)
    parent.append(wrapper)
  }
  function select(parent: HTMLElement, label: string, key: string, values: [string, string][]) {
    const element = node('select')
    for (const [value, name] of values) {
      const option = node('option')
      option.value = value
      option.textContent = name
      element.append(option)
    }
    element.value = String(filters[key] ?? '')
    element.addEventListener('change', () => {
      filters[key] = element.value || undefined
      page = 1
      void load()
    })
    control(parent, label, element)
  }
  function input(parent: HTMLElement, label: string, key: string, type = 'text') {
    const element = node('input')
    element.type = type
    element.value = filters[key] == null ? '' : String(filters[key]).replace(/:00Z$/, '')
    element.addEventListener('change', () => {
      filters[key] =
        element.value === ''
          ? undefined
          : type === 'number'
            ? Number(element.value)
            : type === 'datetime-local'
              ? `${element.value}:00Z`
              : element.value
      page = 1
      void load()
    })
    control(parent, label, element)
  }
  function options() {
    const copy = { ...filters }
    delete copy.confidence
    const confidence = String(filters.confidence ?? '')
    if (confidence.startsWith('VIIRS:')) {
      copy.sensor ??= 'VIIRS'
      copy.viirsConfidence = [confidence.slice(6)]
    }
    if (confidence.startsWith('MODIS:')) {
      copy.sensor ??= 'MODIS'
      if (confidence === 'MODIS:unknown') copy.modisConfidenceUnknown = true
      else {
        const [min, max] = confidence.slice(6).split('-').map(Number)
        copy.modisConfidenceMin = min
        copy.modisConfidenceMax = max
      }
    }
    return { ...copy, page, pageSize }
  }
  function payload() {
    return {
      snapshotId: config.snapshotId,
      window: config.window,
      aggregateId: config.aggregateId,
      observationId: config.observationId,
      options: options(),
    }
  }
  async function load() {
    pending?.abort()
    pending = new AbortController()
    const request = pending
    const current = ++revision
    busy = true
    error = ''
    render()
    try {
      const response = await fetch('/firms-api/global/observations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload()),
        signal: request.signal,
      })
      const data = await response.json()
      if (!response.ok)
        throw new Error(
          data.message ?? data.detail ?? `Observation inspection failed (${response.status}).`,
        )
      if (disposed || request.signal.aborted || current !== revision) return
      result = data
      busy = false
      render()
    } catch (err) {
      if (!disposed && !request.signal.aborted && current === revision) {
        busy = false
        error = err instanceof Error ? err.message : 'Observation inspection failed.'
        render()
      }
    }
  }
  async function exportMatching(format: string) {
    try {
      const response = await fetch('/firms-api/global/observations/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload(), format }),
      })
      if (!response.ok) {
        const body = await response.json()
        throw new Error(body.message ?? body.detail ?? 'Export failed.')
      }
      if (!disposed)
        downloadBlob(await response.blob(), `sharp-global-${config.snapshotId}.${format}`)
    } catch (err) {
      if (!disposed) {
        error = err instanceof Error ? err.message : 'Export failed.'
        render()
      }
    }
  }
  function inspect(row: RecordRow) {
    selected = row
    const feature = canonicalGlobalFeature({
      type: 'Feature',
      id: row.id,
      geometry: { type: 'Point', coordinates: [row.longitude, row.latitude] },
      properties: { ...row, kind: 'observation' },
    })
    config.onSelect(feature)
    render()
  }
  function render() {
    root.replaceChildren()
    const title = node('strong', 'fire-popup-drag-handle')
    title.textContent = selected ? 'Satellite hotspot' : 'Aggregated satellite hotspots'
    root.append(title)
    if (selected) {
      field(root, 'Acquired', formatFireTime(selected.acquiredAt))
      field(
        root,
        'Instrument / satellite',
        `${selected.sensor} / ${firePlatformLabel(selected.platform)}`,
      )
      field(root, 'FRP', selected.frpMw == null ? 'Unknown' : `${selected.frpMw.toFixed(1)} MW`)
      field(
        root,
        'Native confidence',
        `${selected.confidence.value ?? 'Unknown'}${selected.sensor === 'MODIS' ? ' / 100 (MODIS)' : ' (VIIRS class)'}`,
      )
      field(
        root,
        'Observation age now',
        `${Math.max(0, (Date.now() - Date.parse(selected.acquiredAt)) / 3600000).toFixed(1)} hours`,
      )
      field(root, 'Coordinates', `${selected.latitude}, ${selected.longitude}`)
      field(root, 'Day / night', selected.dayNight)
      field(
        root,
        'Reported scan / track',
        `${selected.scanKm ?? 'Unknown'} / ${selected.trackKm ?? 'Unknown'} km`,
      )
      const buttons = node('div', 'fire-popup-button-row')
      const coordinates = `${selected.latitude}, ${selected.longitude}`
      action(buttons, 'Copy coordinates', () => {
        void navigator.clipboard?.writeText(coordinates).catch(() => {
          error = 'Select the coordinates to copy them.'
          render()
        })
      })
      action(buttons, 'Return to group', () => {
        selected = null
        config.onSelect(null)
        render()
      })
      root.append(buttons)
      return
    }
    const summary = node('div', 'fire-popup-summary')
    const data = result?.data
    field(
      summary,
      'Observations',
      data
        ? `${data.total.toLocaleString()} matching out of ${data.summary.selectedCount.toLocaleString()}`
        : 'Loading stored membership…',
    )
    if (data) {
      field(
        summary,
        'Acquired UTC',
        `${data.summary.earliestAcquisition ? formatFireTime(data.summary.earliestAcquisition) : 'Unknown'} – ${data.summary.latestAcquisition ? formatFireTime(data.summary.latestAcquisition) : 'Unknown'}`,
      )
      field(summary, 'Satellites', data.summary.platforms.map(firePlatformLabel).join(', '))
      field(
        summary,
        'Maximum FRP',
        data.summary.maxFrpMw == null ? 'Unknown' : `${data.summary.maxFrpMw} MW`,
      )
      field(summary, 'Source state', result?.meta.completeness ?? 'Unknown')
    }
    if (error) {
      field(summary, 'Status', error)
      action(summary, 'Retry', () => void load())
    }
    root.append(summary)
    const controls = node('div', 'fire-popup-controls')
    input(controls, 'Search ID, satellite or product', 'search', 'search')
    select(controls, 'Satellite', 'platform', [
      ['', 'All satellites'],
      ...['terra', 'aqua', 'suomi-npp', 'noaa-20', 'noaa-21'].map(
        (p) => [p, firePlatformLabel(p)] as [string, string],
      ),
    ])
    select(controls, 'Sensor', 'sensor', [
      ['', 'All sensors'],
      ['MODIS', 'MODIS'],
      ['VIIRS', 'VIIRS'],
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
    const details = node('details')
    const heading = node('summary')
    heading.textContent = 'Time, FRP and native confidence'
    const advanced = node('div', 'fire-popup-controls')
    input(advanced, 'From UTC (inclusive)', 'acquiredStart', 'datetime-local')
    input(advanced, 'Until UTC (exclusive)', 'acquiredEndExclusive', 'datetime-local')
    input(advanced, 'Minimum FRP (MW)', 'frpMin', 'number')
    input(advanced, 'Maximum FRP (MW)', 'frpMax', 'number')
    select(advanced, 'Sensor-native confidence', 'confidence', [
      ['', 'All native values'],
      ['MODIS:0-29', 'MODIS: 0–29'],
      ['MODIS:30-79', 'MODIS: 30–79'],
      ['MODIS:80-100', 'MODIS: 80–100'],
      ['MODIS:unknown', 'MODIS: unknown'],
      ['VIIRS:low', 'VIIRS: low'],
      ['VIIRS:nominal', 'VIIRS: nominal'],
      ['VIIRS:high', 'VIIRS: high'],
      ['VIIRS:unknown', 'VIIRS: unknown'],
    ])
    details.append(heading, advanced)
    root.append(details)
    const list = node('div', 'fire-popup-list')
    list.tabIndex = 0
    let previous = ''
    for (const row of data?.rows ?? []) {
      if (filters.groupBy !== 'none' && row.groupKey !== previous) {
        const group = data?.groups.find((g) => g.key === row.groupKey)
        const label = node('strong')
        label.textContent = `${group?.label ?? row.groupKey} · ${group?.count ?? 0} observations`
        list.append(label)
        previous = row.groupKey ?? ''
      }
      action(
        list,
        `${formatFireTime(row.acquiredAt)} / ${firePlatformLabel(row.platform)} / ${row.frpMw == null ? 'Unknown FRP' : `${row.frpMw.toFixed(1)} MW`}`,
        () => inspect(row),
      )
    }
    if (busy || !data?.rows.length) {
      const state = node('p')
      state.textContent = busy ? 'Loading matching observations…' : 'No matching observations.'
      list.append(state)
    }
    root.append(list)
    const footer = node('div', 'fire-popup-actions'),
      nav = node('div', 'fire-popup-pagination')
    field(nav, 'Page', `${page} of ${Math.max(1, Math.ceil((data?.total ?? 0) / pageSize))}`)
    action(
      nav,
      'Previous',
      () => {
        page -= 1
        void load()
      },
      busy || page <= 1,
    )
    action(
      nav,
      'Next',
      () => {
        page += 1
        void load()
      },
      busy || page * pageSize >= (data?.total ?? 0),
    )
    const size = node('select')
    for (const count of [10, 25]) {
      const option = node('option')
      option.value = String(count)
      option.textContent = `${count} per page`
      size.append(option)
    }
    size.value = String(pageSize)
    size.addEventListener('change', () => {
      pageSize = Number(size.value)
      page = 1
      void load()
    })
    control(nav, 'Page size', size)
    footer.append(nav)
    const tools = node('div', 'fire-popup-button-row')
    action(tools, 'Clear filters', () => {
      filters = { sort: 'newest', groupBy: 'none' }
      page = 1
      void load()
    })
    action(tools, 'Zoom to observations', config.onZoom)
    footer.append(tools)
    const exports = node('div', 'fire-popup-export-row')
    for (const format of ['csv', 'geojson', 'json'])
      action(
        exports,
        format === 'json' ? 'Reproducibility JSON' : `Export ${format.toUpperCase()}`,
        () => void exportMatching(format),
        busy || !data?.total,
      )
    footer.append(exports)
    root.append(footer)
  }
  void load()
  return {
    root,
    destroy() {
      disposed = true
      pending?.abort()
      config.onSelect(null)
    },
  }
}
