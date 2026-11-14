import type { AnalysisArea } from './analysis-area'

type CountrySelection = { id: string; name: string }

export function createCountrySelectionRequest(options: {
  resolve: (country: CountrySelection, signal: AbortSignal) => Promise<AnalysisArea>
  onLoading: (country: CountrySelection) => void
  onResolved: (area: AnalysisArea) => void
  onFailure: (error: string) => void
}) {
  let revision = 0
  let disposed = false
  let controller: AbortController | null = null

  function cancel() {
    revision++
    controller?.abort()
    controller = null
  }

  return {
    async select(country: CountrySelection) {
      cancel()
      if (disposed) return
      const current = revision
      const request = new AbortController()
      controller = request
      options.onLoading(country)
      try {
        const area = await options.resolve(country, request.signal)
        if (!disposed && current === revision && !request.signal.aborted) options.onResolved(area)
      } catch (error) {
        if (!disposed && current === revision && !request.signal.aborted)
          options.onFailure(
            error instanceof Error
              ? error.message
              : 'The country boundary could not be loaded. Try again.',
          )
      } finally {
        if (current === revision) controller = null
      }
    },
    cancel,
    destroy() {
      disposed = true
      cancel()
    },
  }
}
