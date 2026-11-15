import { createCompactObservationCard } from './popup-presentation'
import type { FireFeature } from '@/lib/fire-severity'
import type { FireInvestigationSelection } from './fire-dots'

export type FrozenObservationSelection = {
  members: FireFeature[]
  query?: FireInvestigationSelection['query']
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
  const selection = options.selection
  let resolving = true
  let failed = false
  const { root, button } = createCompactObservationCard(() => {
    if (resolving || failed || !selection.members.length) return
    if (selection.query && !selection.selectionToken) return
    options.onOpenAnalytics?.({
      query: selection.query,
      selectionToken: selection.selectionToken,
      observationIds: selection.selectionToken
        ? undefined
        : selection.members.map((feature) => feature.properties.id),
      sourceGeneration: selection.sourceGeneration,
      queryIdentity: selection.queryIdentity,
    })
  })
  const error = document.createElement('p')
  error.className = 'fire-popup-error'
  error.setAttribute('role', 'alert')

  function render(message = '') {
    resolving = message.startsWith('Resolving ') || message.startsWith('Saving ')
    failed = !!message && !resolving
    button.disabled =
      resolving ||
      failed ||
      !options.onOpenAnalytics ||
      !selection.members.length ||
      (!!selection.query && !selection.selectionToken)
    root.setAttribute('aria-busy', String(resolving))
    if (failed) {
      error.textContent = message
      root.append(error)
    } else error.remove()
  }

  render('Resolving selected observation membership')
  return { root, anchor: options.anchor, render }
}
