import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch } from 'react'
import { loadAnalysisCountries, resolveAnalysisCountry } from '@/lib/analysis-countries'
import { createCountrySelectionRequest } from '@/lib/analysis-country-selection'
import type { AnalysisAction, AnalysisState } from '@/lib/analysis-state'
import type { SearchPlace } from '@/lib/locations'

export function useAnalysisCountrySelection(
  enabled: boolean,
  analysis: AnalysisState,
  dispatch: Dispatch<AnalysisAction>,
) {
  const [countries, setCountries] = useState<SearchPlace[]>([])
  const [catalogueLoading, setCatalogueLoading] = useState(true)
  const [catalogueError, setCatalogueError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [picking, setPicking] = useState(false)
  const [lastCountryId, setLastCountryId] = useState<string | null>(null)
  const countriesRef = useRef(countries)
  const request = useMemo(
    () =>
      createCountrySelectionRequest({
        resolve: async (selected, signal) => {
          const catalogue = await loadAnalysisCountries()
          signal.throwIfAborted()
          const country = catalogue.find((item) => item.id === selected.id)
          if (!country) throw new Error('This outline has no matching detailed country boundary.')
          return resolveAnalysisCountry(country, { signal })
        },
        onLoading: (country) => {
          setLastCountryId(country.id)
          dispatch({ type: 'country-loading', country })
        },
        onResolved: (area) => {
          setPicking(false)
          dispatch({ type: 'preview', area })
        },
        onFailure: (error) => dispatch({ type: 'country-failure', error }),
      }),
    [dispatch],
  )

  useEffect(() => {
    if (!enabled) return
    let active = true
    loadAnalysisCountries().then(
      (items) => {
        if (!active) return
        countriesRef.current = items
        setCountries(items)
        setCatalogueLoading(false)
      },
      (error: unknown) => {
        if (!active) return
        setCatalogueError(
          error instanceof Error ? error.message : 'Country catalogue could not be loaded.',
        )
        setCatalogueLoading(false)
      },
    )
    return () => {
      active = false
    }
  }, [enabled, attempt])

  const stopPicking = useCallback(() => {
    request.cancel()
    setPicking(false)
  }, [request])

  const cancel = useCallback(() => {
    stopPicking()
    dispatch({ type: 'cancel' })
  }, [stopPicking, dispatch])

  useEffect(() => {
    if (!enabled) request.cancel()
  }, [enabled, request])

  useEffect(() => {
    if (!enabled) return
    function keyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('[role="dialog"], [data-radix-popper-content-wrapper]')) return
      if (
        document.querySelector(
          '[data-slot="popover-content"][data-state="open"], [role="dialog"][data-state="open"], [role="dialog"][aria-modal="true"]',
        )
      )
        return
      if (!picking && analysis.phase === 'idle') return
      event.preventDefault()
      cancel()
    }
    document.addEventListener('keydown', keyDown)
    return () => document.removeEventListener('keydown', keyDown)
  }, [enabled, picking, analysis.phase, cancel])

  useEffect(() => () => request.cancel(), [request])

  const selectCountry = useCallback(
    (countryId: string) => {
      const country = countriesRef.current.find((item) => item.id === countryId)
      void request.select({
        id: countryId,
        name: country?.name ?? countryId.replace(/^country:/, ''),
      })
    },
    [request],
  )

  const clear = useCallback(() => {
    stopPicking()
    dispatch({ type: 'clear' })
  }, [stopPicking, dispatch])

  return {
    countries,
    catalogueLoading,
    catalogueError,
    retryCatalogue: () => {
      setCatalogueLoading(true)
      setCatalogueError('')
      setAttempt((value) => value + 1)
    },
    picking: enabled && picking,
    setPicking,
    lastCountryId,
    selectCountry,
    stopPicking,
    cancel,
    clear,
  }
}
