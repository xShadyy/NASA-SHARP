import {
  popupField as field,
  popupAction as action,
  appendObservationScience,
  createCompactObservationCard,
} from './popup-presentation'
import { apiUrl } from '@/lib/api-config'
import { firePlatformLabel, formatFireTime, type FireFeature } from '@/lib/fire-severity'
import { canonicalGlobalFeature } from '@/lib/global-tiles'
import type { GlobalWindow } from '@/hooks/use-global-fires'
import type { FrozenSelection } from '@/lib/investigation'

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
}

export function createGlobalObservationPopup(config: {
  snapshotId: string
  window: GlobalWindow
  aggregateId?: string
  interval?: { start: string; endExclusive: string }
  onOpenAnalytics?: (selection: FrozenSelection) => void
  onRefreshSnapshot?: () => void
  observationId?: string
  onSelect: (feature: FireFeature | null) => void
  onZoom: () => void
}) {
  let disposed = false
  let revision = 0
  let pending: AbortController | null = null
  let selected: RecordRow | null = null
  let error = ''

  function openAnalytics(observationId?: string) {
    if (disposed || !config.interval) return
    config.onOpenAnalytics?.({
      global: {
        snapshotId: config.snapshotId,
        window: config.window,
        aggregateId: config.aggregateId,
        interval: config.interval,
      },
      sourceGeneration: config.snapshotId,
      ...(observationId ? { filters: { observationId } } : {}),
    })
  }

  const compact = createCompactObservationCard(() => openAnalytics())
  const root = compact.root
  compact.button.disabled = !config.onOpenAnalytics || !config.interval
  const compactNodes = Array.from(root.childNodes)

  function renderGroup() {
    root.className = 'fire-popup fire-popup-group fire-popup-compact'
    root.removeAttribute('aria-busy')
    root.replaceChildren(...compactNodes)
  }

  function renderReading() {
    root.className = 'fire-popup fire-popup-group'
    root.replaceChildren()
    root.setAttribute('aria-busy', String(!selected && !error))
    const title = document.createElement('strong')
    title.className = 'fire-popup-drag-handle'
    title.textContent = 'Satellite hotspot'
    root.append(title)
    if (!selected) {
      const state = document.createElement('p')
      state.textContent = error || 'Loading satellite observation…'
      if (error) state.setAttribute('role', 'alert')
      root.append(state)
      if (error) {
        action(root, 'Retry', () => void load())
        if (config.onRefreshSnapshot)
          action(root, 'Close and refresh map dataset', config.onRefreshSnapshot)
      }
      return
    }

    const record = selected
    appendObservationScience(root, record as unknown as Record<string, unknown>)
    field(root, 'Acquired UTC', formatFireTime(record.acquiredAt))
    field(
      root,
      'Instrument / satellite',
      `${record.sensor || 'Unknown'} / ${firePlatformLabel(record.platform) || 'Unknown'}`,
    )
    field(root, 'FRP', record.frpMw == null ? 'Unknown' : `${record.frpMw.toFixed(1)} MW`)
    const confidenceUnit =
      record.sensor === 'MODIS'
        ? ' / 100 (MODIS)'
        : record.sensor === 'VIIRS'
          ? ' (VIIRS class)'
          : ''
    field(root, 'Native confidence', `${record.confidence?.value ?? 'Unknown'}${confidenceUnit}`)
    field(
      root,
      'Observation age now',
      `${Math.max(0, (Date.now() - Date.parse(record.acquiredAt)) / 3600000).toFixed(1)} hours`,
    )
    const coordinates = `${record.latitude}, ${record.longitude}`
    field(root, 'Coordinates', coordinates)
    field(root, 'Day / night', record.dayNight)
    field(
      root,
      'Reported scan / track',
      `${record.scanKm ?? 'Unknown'} / ${record.trackKm ?? 'Unknown'} km`,
    )
    const buttons = document.createElement('div')
    buttons.className = 'fire-popup-button-row'
    action(buttons, 'Copy coordinates', () => {
      const copy = navigator.clipboard?.writeText(coordinates)
      if (copy)
        void copy.catch(() => {
          if (!disposed && selected === record) showCopyHint()
        })
      else showCopyHint()
    })
    if (config.aggregateId)
      action(buttons, 'Return to group', () => {
        selected = null
        config.onSelect(null)
        renderGroup()
      })
    if (config.onOpenAnalytics && config.interval)
      action(buttons, 'Open in Area Analytics', () => openAnalytics(record.id))
    root.append(buttons)

    function showCopyHint() {
      const hint = document.createElement('p')
      hint.textContent = 'Select the coordinates to copy them.'
      hint.setAttribute('role', 'status')
      root.append(hint)
    }
  }

  async function load() {
    if (disposed || !config.observationId) return
    pending?.abort()
    const request = new AbortController()
    pending = request
    const current = ++revision
    error = ''
    renderReading()
    try {
      const response = await fetch(apiUrl('/global/observations'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          snapshotId: config.snapshotId,
          window: config.window,
          aggregateId: config.aggregateId,
          observationId: config.observationId,
          options: { page: 1, pageSize: 1 },
        }),
        signal: request.signal,
      })
      const data = await response.json()
      if (!response.ok)
        throw new Error(
          data.message ?? data.detail ?? `Observation inspection failed (${response.status}).`,
        )
      if (disposed || request.signal.aborted || current !== revision) return
      selected =
        (data.data?.rows as RecordRow[] | undefined)?.find(
          (record) => record.id === config.observationId,
        ) ?? null
      if (!selected) throw new Error('This observation is unavailable in the selected snapshot.')
      config.onSelect(
        canonicalGlobalFeature({
          type: 'Feature',
          id: selected.id,
          geometry: { type: 'Point', coordinates: [selected.longitude, selected.latitude] },
          properties: { ...selected, kind: 'observation' },
        }),
      )
      renderReading()
    } catch (err) {
      if (!disposed && !request.signal.aborted && current === revision) {
        error = err instanceof Error ? err.message : 'Observation inspection failed.'
        renderReading()
      }
    }
  }

  if (config.observationId) void load()
  return {
    root,
    destroy() {
      disposed = true
      revision += 1
      pending?.abort()
      config.onSelect(null)
    },
  }
}
