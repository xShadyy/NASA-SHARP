/** Test-only production-build alias for the previous JSON -> GeoJSON renderer. */
import type { Map as MapLibreMap } from 'maplibre-gl'
import type { GlobalManifest } from '@/hooks/use-global-fires'
import {
  createGlobalFireController,
  GLOBAL_AGGREGATE_SOURCE,
  type GlobalDisplayStatus,
} from '@/map/global-fire-controller'
import { createFireDotController } from '@/map/fire-dots'
import { FIRE_POINT_SOURCE } from '@/map/fire-map-style'

export const GLOBAL_RASTER_PREFIX = GLOBAL_AGGREGATE_SOURCE
export type GlobalRasterDisplayStatus = GlobalDisplayStatus & {
  sourceId?: string
  displayedManifest: GlobalManifest | null
}

export function createGlobalRasterController(
  map: MapLibreMap,
  options: { onStatus: (status: GlobalRasterDisplayStatus) => void },
) {
  let manifest: GlobalManifest | null = null
  let pending: GlobalDisplayStatus | null = null
  const observations = createFireDotController(map)
  observations.setInteractive(false)
  observations.setDisplay({ disableClustering: true, disableFootprints: true })
  function forward(status: GlobalDisplayStatus) {
    map.getContainer().dataset.legacyGlobalDisplayFeatures = String(status.displayFeatures)
    map.getContainer().dataset.legacyGlobalLoading = String(status.loading)
    options.onStatus({
      ...status,
      // Keep canonical investigation scope separate from display symbol count.
      displayFeatures: manifest?.count ?? 0,
      sourceId: GLOBAL_AGGREGATE_SOURCE,
      displayedManifest: manifest,
    })
  }
  function rendered() {
    if (!pending) return
    if (
      [GLOBAL_AGGREGATE_SOURCE, FIRE_POINT_SOURCE].every(
        (id) => map.getSource(id) && map.isSourceLoaded(id),
      )
    ) {
      const status = pending
      pending = null
      forward(status)
    }
  }
  const legacy = createGlobalFireController(map, {
    displayOnly: true,
    onObservations: (features) => observations.setData(features),
    onStatus: (status) => {
      if (status.loading || status.error) forward(status)
      else {
        pending = status
        map.triggerRepaint()
      }
    },
  })
  map.on('render', rendered)
  return {
    ...legacy,
    setManifest(next: GlobalManifest | null) {
      manifest = next
      legacy.setManifest(next)
    },
    setEnabled(enabled: boolean) {
      legacy.setEnabled(enabled)
      if (!enabled) observations.setData([])
    },
    destroy() {
      map.off('render', rendered)
      legacy.destroy()
      observations.destroy()
    },
  }
}
