import type { AreaBounds, AreaGeometry } from '@/lib/analysis-area'
import { prepareAnalysisDisplayGeometry, prepareCountryDisplayGeometry } from './analysis-geometry'

self.onmessage = (
  event: MessageEvent<
    AreaGeometry | { type: 'country'; geometry: AreaGeometry; preferredBounds?: AreaBounds }
  >,
) => {
  try {
    const result =
      event.data.type === 'country'
        ? prepareCountryDisplayGeometry(event.data.geometry, event.data.preferredBounds)
        : prepareAnalysisDisplayGeometry(event.data)
    self.postMessage({ result })
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : 'The selected area could not be prepared.',
    })
  }
}
