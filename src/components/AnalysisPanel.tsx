import { useEffect, useId, useRef, useState } from 'react'
import { Command as CommandPrimitive } from 'cmdk'
import {
  ArrowCounterClockwiseIcon,
  CheckCircleIcon,
  GlobeHemisphereWestIcon,
  PolygonIcon,
  RectangleIcon,
  XIcon,
} from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Command, CommandItem, CommandList } from '@/components/ui/command'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { loadAnalysisCountries, resolveAnalysisCountry } from '@/lib/analysis-countries'
import { areaPolygons, type AnalysisArea } from '@/lib/analysis-area'
import type { AnalysisState } from '@/lib/analysis-state'
import { matchLocalPlaces, type SearchPlace } from '@/lib/locations'
import './AnalysisPanel.css'

type AnalysisPanelProps = {
  state: AnalysisState
  ready: boolean
  onPreview: (area: AnalysisArea) => void
  onDraw: (tool: 'polygon' | 'rectangle') => void
  onFinish: () => void
  onEdit: () => void
  onConfirm: () => void
  onCancel: () => void
  onClear: () => void
  onClose: () => void
}

export function AnalysisPanel({
  state,
  ready,
  onPreview,
  onDraw,
  onFinish,
  onEdit,
  onConfirm,
  onCancel,
  onClear,
  onClose,
}: AnalysisPanelProps) {
  const [method, setMethod] = useState<'country' | 'draw'>(() =>
    (state.draft ?? state.confirmed)?.type === 'country' || !(state.draft ?? state.confirmed)
      ? 'country'
      : 'draw',
  )
  const [countries, setCountries] = useState<SearchPlace[]>([])
  const [catalogueLoading, setCatalogueLoading] = useState(true)
  const [catalogueError, setCatalogueError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [query, setQuery] = useState('')
  const [loadingCountry, setLoadingCountry] = useState<SearchPlace | null>(null)
  const [boundaryError, setBoundaryError] = useState('')
  const [lastCountry, setLastCountry] = useState<SearchPlace | null>(null)
  const request = useRef(0)
  const id = useId()
  const area = state.draft ?? state.confirmed
  const results = query.trim() ? matchLocalPlaces(countries, query, 242) : countries
  const activeDraft = state.phase !== 'idle' || Boolean(loadingCountry)

  useEffect(() => {
    let active = true
    loadAnalysisCountries().then(
      (items) => {
        if (active) {
          setCountries(items)
          setCatalogueLoading(false)
        }
      },
      (error: unknown) => {
        if (active) {
          setCatalogueError(
            error instanceof Error ? error.message : 'Country catalogue could not be loaded.',
          )
          setCatalogueLoading(false)
        }
      },
    )
    return () => {
      active = false
    }
  }, [attempt])

  useEffect(
    () => () => {
      request.current++
    },
    [],
  )

  function cancel() {
    request.current++
    setLoadingCountry(null)
    setBoundaryError('')
    onCancel()
  }

  async function chooseCountry(country: SearchPlace) {
    const current = ++request.current
    onCancel()
    setLastCountry(country)
    setLoadingCountry(country)
    setBoundaryError('')
    setQuery(country.name)
    try {
      const resolved = await resolveAnalysisCountry(country)
      if (request.current === current) {
        onPreview(resolved)
        setLoadingCountry(null)
      }
    } catch (error) {
      if (request.current === current) {
        setBoundaryError(
          error instanceof Error ? error.message : 'The country boundary could not be loaded.',
        )
        setLoadingCountry(null)
      }
    }
  }

  function draw(tool: 'polygon' | 'rectangle') {
    request.current++
    setLoadingCountry(null)
    setBoundaryError('')
    onDraw(tool)
  }

  return (
    <aside
      className="analysis-panel"
      aria-labelledby={`${id}-title`}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented && activeDraft) {
          event.preventDefault()
          event.stopPropagation()
          cancel()
        }
      }}
    >
      <header className="analysis-panel-header">
        <div>
          <span className="analysis-eyebrow">WORKSPACE</span>
          <h1 id={`${id}-title`}>Analysis</h1>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close Analysis"
          onClick={onClose}
        >
          <XIcon size={19} />
        </Button>
      </header>
      <div className="analysis-panel-body">
        <section aria-labelledby={`${id}-area-title`}>
          <h2 id={`${id}-area-title`}>Area of interest</h2>
          <p className="analysis-intro">
            Choose the boundary you want to work with. Preview it on the map before confirming.
          </p>
          <ToggleGroup
            type="single"
            value={method}
            className="analysis-methods"
            aria-label="Area selection method"
            onValueChange={(value) => {
              if ((value !== 'country' && value !== 'draw') || value === method) return
              cancel()
              setMethod(value)
            }}
          >
            <ToggleGroupItem value="country">
              <GlobeHemisphereWestIcon size={18} />
              Country
            </ToggleGroupItem>
            <ToggleGroupItem value="draw">
              <PolygonIcon size={18} />
              Draw area
            </ToggleGroupItem>
          </ToggleGroup>

          {method === 'country' ? (
            <div className="analysis-country-section">
              <span className="analysis-field-label">
                Country
              </span>
              {catalogueLoading && (
                <p className="analysis-notice" role="status">
                  Loading countries.
                </p>
              )}
              {catalogueError && (
                <div className="analysis-error" role="alert">
                  <p>{catalogueError}</p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setCatalogueLoading(true)
                      setCatalogueError('')
                      setAttempt((value) => value + 1)
                    }}
                  >
                    Retry country list
                  </Button>
                </div>
              )}
              {!catalogueError && (
                <Command
                  shouldFilter={false}
                  className="analysis-country-search"
                  label="Search countries"
                >
                  <CommandPrimitive.Input
                    value={query}
                    onValueChange={setQuery}
                    placeholder="Search countries"
                    className="analysis-country-input"
                    disabled={catalogueLoading}
                    aria-label="Search countries"
                  />
                  <CommandList className="analysis-country-list" aria-label="Countries">
                    {results.map((country) => (
                      <CommandItem
                        key={country.id}
                        value={country.id}
                        onSelect={() => {
                          void chooseCountry(country)
                        }}
                        aria-label={country.name}
                      >
                        <span>{country.name}</span>
                        {area?.id === country.id && (
                          <CheckCircleIcon size={16} aria-hidden="true" />
                        )}
                      </CommandItem>
                    ))}
                    {!catalogueLoading && !results.length && (
                      <p className="analysis-notice">No matching countries. Try another name.</p>
                    )}
                  </CommandList>
                </Command>
              )}
              <p className="analysis-source-note">
                Generalized Natural Earth boundaries, with the source’s islands and interior holes
                retained.
              </p>
              {loadingCountry && (
                <p className="analysis-notice" role="status">
                  Loading the boundary for {loadingCountry.name}.
                </p>
              )}
              {boundaryError && (
                <div className="analysis-error" role="alert">
                  <p>{boundaryError}</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (lastCountry) void chooseCountry(lastCountry)
                    }}
                  >
                    Retry boundary
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="analysis-draw-section">
              <span className="analysis-field-label">Drawing tool</span>
              <div className="analysis-draw-tools">
                <Button
                  type="button"
                  variant="outline"
                  disabled={!ready}
                  aria-pressed={state.phase === 'drawing' && state.tool === 'polygon'}
                  onClick={() => draw('polygon')}
                >
                  <PolygonIcon size={22} />
                  <span>Draw polygon</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!ready}
                  aria-pressed={state.phase === 'drawing' && state.tool === 'rectangle'}
                  onClick={() => draw('rectangle')}
                >
                  <RectangleIcon size={22} />
                  <span>Draw rectangle</span>
                </Button>
              </div>
              <div className="analysis-draw-instructions" role="status">
                {state.phase === 'drawing'
                  ? state.tool === 'rectangle'
                    ? 'Click one corner on the map, then click the opposite corner to finish. Escape cancels.'
                    : `Click to add vertices, then click the first vertex or choose Finish drawing. ${state.vertices} vertices placed. Escape cancels.`
                  : state.phase === 'editing'
                    ? 'Drag the boundary handles to adjust the area. Polygon edge handles add vertices. Choose Finish editing when ready.'
                    : 'Draw across any country borders. The shape you draw defines the area; it is not clipped to a country.'}
              </div>
              {state.phase === 'review' && state.draft && state.draft.type !== 'country' && (
                <Button
                  type="button"
                  variant="outline"
                  className="analysis-finish"
                  onClick={onEdit}
                >
                  Edit area
                </Button>
              )}
              {(state.phase === 'drawing' || state.phase === 'editing') && (
                <Button
                  type="button"
                  variant="outline"
                  className="analysis-finish"
                  onClick={onFinish}
                  disabled={
                    state.phase === 'drawing' && state.tool === 'polygon' && state.vertices < 3
                  }
                >
                  {state.phase === 'editing' ? 'Finish editing' : 'Finish drawing'}
                </Button>
              )}
            </div>
          )}
        </section>

        <section className="analysis-selection" aria-label="Selection summary" aria-live="polite">
          <span className="analysis-status">
            {activeDraft
              ? 'Draft preview'
              : state.confirmed
                ? 'Confirmed area'
                : 'No area selected'}
          </span>
          <h3>{loadingCountry?.name ?? area?.name ?? 'Define your area'}</h3>
          {area && !loadingCountry ? (
            <p>
              {area.type === 'country'
                ? 'Country boundary'
                : area.type === 'rectangle'
                  ? 'Custom rectangle'
                  : 'Custom polygon'}
              {area.type === 'country' && areaPolygons(area.geometry).length > 1
                ? ` · ${areaPolygons(area.geometry).length} polygon parts`
                : ''}
            </p>
          ) : (
            <p>
              {state.phase === 'drawing'
                ? 'Your boundary will appear here when the drawing is complete.'
                : 'Select a country or draw a polygon or rectangle on the map.'}
            </p>
          )}
          {state.confirmed && activeDraft && (
            <p className="analysis-confirmed-note">
              Confirmed area: {state.confirmed.name}. Cancel restores it.
            </p>
          )}
          {state.error && (
            <p className="analysis-error" role="alert">
              {state.error}
            </p>
          )}
          {!activeDraft && state.confirmed && (
            <p className="analysis-confirmed-note">Area confirmed. No analysis has been run.</p>
          )}
        </section>
      </div>
      <footer className="analysis-panel-footer">
        {activeDraft ? (
          <>
            <Button
              type="button"
              className="analysis-confirm"
              disabled={
                !ready ||
                !state.draft ||
                Boolean(state.error) ||
                Boolean(loadingCountry) ||
                state.phase === 'drawing'
              }
              onClick={onConfirm}
            >
              <CheckCircleIcon size={18} />
              Use this area
            </Button>
            <Button type="button" variant="outline" onClick={cancel}>
              Cancel
            </Button>
          </>
        ) : (
          area && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setMethod(area.type === 'country' ? 'country' : 'draw')
                onEdit()
              }}
            >
              Edit area
            </Button>
          )
        )}
        {(state.confirmed || state.draft || state.phase !== 'idle' || loadingCountry) && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              request.current++
              setLoadingCountry(null)
              setBoundaryError('')
              setQuery('')
              onClear()
            }}
          >
            <ArrowCounterClockwiseIcon size={16} />
            Clear area
          </Button>
        )}
      </footer>
    </aside>
  )
}
