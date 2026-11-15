import { useDeferredValue, useId, useMemo, useState } from 'react'
import { Command as CommandPrimitive } from 'cmdk'
import {
  ArrowCounterClockwiseIcon,
  CheckCircleIcon,
  CrosshairIcon,
  GlobeHemisphereWestIcon,
  PolygonIcon,
  RectangleIcon,
  XIcon,
} from '@phosphor-icons/react'
import { AnalysisActivity } from '@/components/AnalysisActivity'
import { Button } from '@/components/ui/button'
import { AnalysisDatePicker } from '@/components/AnalysisDatePicker'
import { Command, CommandItem, CommandList } from '@/components/ui/command'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { areaPolygons } from '@/lib/analysis-area'
import { type AnalysisRange } from '@/lib/analysis-activity'
import type { AnalysisActivityData, AnalysisMetadata } from '@/lib/analysis-api'
import { FIRE_LEVELS } from '@/lib/fire-severity'
import type { AnalysisFireStatus } from '@/hooks/use-analysis-fires'
import type { AnalysisState } from '@/lib/analysis-state'
import { matchLocalPlaces, type SearchPlace } from '@/lib/locations'
import type { MapView } from '@/map/projection'
import './AnalysisPanel.css'

type AnalysisPanelProps = {
  state: AnalysisState
  ready: boolean
  view: MapView
  countries: SearchPlace[]
  catalogueLoading: boolean
  catalogueError: string
  picking: boolean
  canRetryBoundary: boolean
  onRetryCatalogue: () => void
  onRetryBoundary: () => void
  onCountrySelect: (countryId: string) => void
  onPickingChange: (enabled: boolean) => void
  onDraw: (tool: 'polygon' | 'rectangle') => void
  onFinish: () => void
  onEdit: () => void
  onConfirm: () => void
  onFitArea: () => void
  onCancel: () => void
  onClear: () => void
  onClose: () => void
  range: AnalysisRange
  generation: number
  onRangeChange: (range: AnalysisRange) => void
  focusedDay: string | null
  onFocusDay: (day: string | null) => void
  activity: AnalysisActivityData | null
  fireMeta: AnalysisMetadata | null
  fireStatus: AnalysisFireStatus
  fireCount: number
  fireMessage: string
  onRetryFires: () => void
}

export function AnalysisPanel({
  state,
  ready,
  countries,
  catalogueLoading,
  catalogueError,
  picking,
  canRetryBoundary,
  onRetryCatalogue,
  onRetryBoundary,
  onCountrySelect,
  onPickingChange,
  onDraw,
  onFinish,
  onEdit,
  onConfirm,
  onFitArea,
  onCancel,
  onClear,
  onClose,
  range,
  onRangeChange,
  focusedDay,
  onFocusDay,
  activity,
  fireMeta,
  fireStatus,
  fireCount,
  fireMessage,
  onRetryFires,
}: AnalysisPanelProps) {
  const [tab, setTab] = useState<'area' | 'activity'>('area')
  const [method, setMethod] = useState<'country' | 'draw'>(() =>
    (state.draft ?? state.confirmed)?.type === 'country' || !(state.draft ?? state.confirmed)
      ? 'country'
      : 'draw',
  )
  const selectedCountry =
    state.pendingCountry ??
    ((state.draft ?? state.confirmed)?.type === 'country' ? (state.draft ?? state.confirmed) : null)
  const [query, setQuery] = useState(() => {
    if (state.pendingCountry) return state.pendingCountry.name
    const selected = state.draft ?? state.confirmed
    return selected?.type === 'country' ? selected.name : ''
  })
  const [queryCountry, setQueryCountry] = useState(() => ({
    id: selectedCountry?.id ?? null,
    request: state.pendingCountry,
  }))
  if (
    queryCountry.id !== (selectedCountry?.id ?? null) ||
    (state.pendingCountry && queryCountry.request !== state.pendingCountry)
  ) {
    setQueryCountry({ id: selectedCountry?.id ?? null, request: state.pendingCountry })
    if (selectedCountry) setQuery(selectedCountry.name)
  }
  const deferredQuery = useDeferredValue(query)
  const id = useId()
  const area = state.draft ?? state.confirmed
  const results = useMemo(
    () =>
      deferredQuery.trim()
        ? matchLocalPlaces(countries, deferredQuery, countries.length)
        : countries,
    [countries, deferredQuery],
  )
  const activeDraft = state.phase !== 'idle'
  const loadingCountry = state.pendingCountry

  function draw(tool: 'polygon' | 'rectangle') {
    onCancel()
    onDraw(tool)
  }

  return (
    <aside
      className="analysis-panel"
      aria-labelledby={`${id}-title`}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented && (activeDraft || picking)) {
          event.preventDefault()
          event.stopPropagation()
          onCancel()
        }
      }}
    >
      <header className="analysis-panel-header">
        <div className="analysis-heading">
          <h1 id={`${id}-title`}>Burning Activity Calendar</h1>
          <ToggleGroup
            type="single"
            value={tab}
            className="analysis-tabs"
            aria-label="Burning Activity Calendar sections"
            onValueChange={(value) => {
              if (value === 'area' || value === 'activity') setTab(value)
            }}
          >
            <ToggleGroupItem value="area">Area</ToggleGroupItem>
            <ToggleGroupItem value="activity">Activity</ToggleGroupItem>
          </ToggleGroup>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close Burning Activity Calendar"
          onClick={onClose}
        >
          <XIcon size={19} />
        </Button>
      </header>
      <section className="analysis-data-context" aria-label="Map observations and status">
        <div className="analysis-context-row">
          <strong>{activity?.areaName ?? state.confirmed?.name ?? 'Select an area'}</strong>
          <span className="analysis-query-state" data-state={fireStatus}>
            {
              {
                idle: 'Not loaded',
                loading: 'Loading',
                ready: fireCount ? 'Loaded' : 'No detections',
                partial: 'Partial data',
                unavailable: 'Unavailable',
                stale: 'Stale data',
                error: 'Request failed',
              }[fireStatus]
            }
          </span>
        </div>
        <p className="analysis-query-dates">
          {(activity?.range ?? range).start} - {(activity?.range ?? range).end} UTC
        </p>
        <div className="analysis-color-heading">
          <span>Fire radiative power (MW)</span>
        </div>
        <ul className="analysis-compact-legend" aria-label="Fire radiative power">
          {FIRE_LEVELS.map((item) => (
            <li key={item.id}>
              <span style={{ background: item.color }} />
              {item.detail.replace('to under', '-<')}
            </li>
          ))}
        </ul>
        <details className="analysis-source-details">
          <summary>
            Source checked:{' '}
            {fireMeta?.fetchedAt
              ? fireMeta.fetchedAt.replace('T', ' ').replace(/(?:\.\d+)?Z$/, '') + ' UTC'
              : 'not loaded'}
          </summary>
          {fireMeta?.newestObservationAt && (
            <p>
              Latest satellite observation:{' '}
              {fireMeta.newestObservationAt.replace('T', ' ').replace(/(?:\.\d+)?Z$/, '')} UTC
            </p>
          )}
          <p>
            FRP is radiative power, not temperature or a danger rating. Squares show satellite
            hotspots; close zoom shows approximate sensor footprints.
          </p>
          {fireMeta?.coverage && <p>{fireMeta.coverage}</p>}
        </details>
      </section>
      <div className="analysis-panel-body">
        {tab === 'activity' && !state.confirmed && (
          <p className="analysis-notice">Confirm an area to see activity.</p>
        )}
        {state.confirmed && (
          <div hidden={tab !== 'activity'}>
            <AnalysisActivity
              key={`${state.confirmed.id}:${range.start}:${range.end}:${range.startAt ?? ''}:${range.endAt ?? ''}`}
              area={state.confirmed}
              range={range}
              activity={activity}
              status={fireStatus}
              message={fireMessage}
              onRetry={onRetryFires}
              focusedDay={focusedDay}
              onFocusDay={onFocusDay}
            />
          </div>
        )}
        {tab === 'area' && (
          <>
            <section aria-labelledby={`${id}-area-title`}>
              <h2 id={`${id}-area-title`}>Area of interest</h2>
              <div className="analysis-selection-tools">
                <ToggleGroup
                  type="single"
                  value={method}
                  className="analysis-methods"
                  aria-label="Area selection method"
                  onValueChange={(value) => {
                    if ((value !== 'country' && value !== 'draw') || value === method) return
                    onCancel()
                    setMethod(value)
                  }}
                >
                  <ToggleGroupItem value="country">
                    <GlobeHemisphereWestIcon size={18} />
                    Select country
                  </ToggleGroupItem>
                  <ToggleGroupItem value="draw">
                    <PolygonIcon size={18} />
                    Draw area
                  </ToggleGroupItem>
                </ToggleGroup>
                <Button
                  type="button"
                  variant="outline"
                  className="analysis-map-pick"
                  aria-pressed={picking}
                  disabled={!ready || catalogueLoading || Boolean(catalogueError)}
                  onClick={() => {
                    if (method !== 'country') {
                      onCancel()
                      setMethod('country')
                      onPickingChange(true)
                    } else onPickingChange(!picking)
                  }}
                >
                  <CrosshairIcon size={14} />
                  Select on map
                </Button>
              </div>

              {method === 'country' ? (
                <div className="analysis-country-section">
                  <span className="analysis-field-label">Country</span>
                  {picking && (
                    <p className="analysis-picking-hint" role="status">
                      Click a highlighted country. Escape cancels selection.
                    </p>
                  )}
                  {catalogueLoading && (
                    <p className="analysis-notice" role="status">
                      Loading countries.
                    </p>
                  )}
                  {catalogueError && (
                    <div className="analysis-error" role="alert">
                      <p>{catalogueError}</p>
                      <Button type="button" size="sm" variant="outline" onClick={onRetryCatalogue}>
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
                        placeholder="Country, alias or ISO code"
                        className="analysis-country-input"
                        disabled={catalogueLoading}
                        aria-label="Search countries"
                      />
                      {(!selectedCountry || query !== selectedCountry.name) && (
                        <CommandList className="analysis-country-list" aria-label="Countries">
                          {results.map((country) => (
                            <CommandItem
                              key={country.id}
                              value={country.id}
                              onSelect={() => {
                                setQuery(country.name)
                                onCountrySelect(country.id)
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
                            <p className="analysis-notice">
                              No matching countries. Try another name.
                            </p>
                          )}
                        </CommandList>
                      )}
                    </Command>
                  )}
                  {loadingCountry && (
                    <p className="analysis-notice" role="status">
                      Loading the boundary for {loadingCountry.name}.
                    </p>
                  )}
                  {state.error && canRetryBoundary && (
                    <div className="analysis-error" role="alert">
                      <p>{state.error}</p>
                      <Button type="button" variant="outline" size="sm" onClick={onRetryBoundary}>
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
                      <PolygonIcon size={18} />
                      <span>Draw polygon</span>
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!ready}
                      aria-pressed={state.phase === 'drawing' && state.tool === 'rectangle'}
                      onClick={() => draw('rectangle')}
                    >
                      <RectangleIcon size={18} />
                      <span>Draw rectangle</span>
                    </Button>
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
            <section className="analysis-period" aria-label="Period">
              <h2>Period</h2>
              <AnalysisDatePicker range={range} onChange={onRangeChange} />
              {fireStatus === 'loading' && (
                <p className="analysis-notice" role="status">
                  Loading observations for this period.
                </p>
              )}
              {['ready', 'partial', 'stale'].includes(fireStatus) && (
                <p className="analysis-notice" role="status">
                  {fireCount === 1
                    ? '1 satellite detection.'
                    : `${fireCount} satellite detections.`}
                </p>
              )}
              {['error', 'unavailable', 'partial', 'stale'].includes(fireStatus) && (
                <div className="analysis-error" role="alert">
                  <p>{fireMessage}</p>
                  {!/180(?:°| degrees)|31 UTC calendar days|smaller region|shorter period/i.test(
                    fireMessage,
                  ) && (
                    <Button type="button" size="sm" variant="outline" onClick={onRetryFires}>
                      Retry fires
                    </Button>
                  )}
                </div>
              )}
              {fireStatus === 'idle' && (
                <p className="analysis-period-note">
                  Confirm the area to show satellite hotspots for this period.
                </p>
              )}
            </section>

            <section
              className="analysis-selection"
              aria-label="Selection summary"
              aria-live="polite"
            >
              <span className="analysis-status">
                {state.phase === 'loading'
                  ? 'Resolving country boundary'
                  : activeDraft
                    ? 'Candidate'
                    : state.confirmed
                      ? 'Confirmed area'
                      : 'No area selected'}
              </span>
              <h3>{loadingCountry?.name ?? area?.name ?? 'Define your area'}</h3>
              {area && !loadingCountry ? (
                area.type !== 'country' && (
                  <p>{area.type === 'rectangle' ? 'Custom rectangle' : 'Custom polygon'}</p>
                )
              ) : state.phase === 'loading' || state.phase === 'drawing' ? (
                <p>
                  {state.phase === 'loading'
                    ? 'Loading the full country boundary.'
                    : 'Your boundary will appear here when the drawing is complete.'}
                </p>
              ) : null}
              {state.confirmed && activeDraft && (
                <p className="analysis-confirmed-note">
                  Confirmed area: {state.confirmed.name}. Escape restores it.
                </p>
              )}
              {state.error && method !== 'country' && (
                <p className="analysis-error" role="alert">
                  {state.error}
                </p>
              )}
              {area?.type === 'country' && areaPolygons(area.geometry).length > 1 && (
                <p className="analysis-confirmed-note">
                  Fit shows the main territory. Islands and distant territories remain in the
                  analysis area.
                </p>
              )}
              {area && (
                <Button
                  type="button"
                  variant="outline"
                  className="analysis-fit-area"
                  onClick={onFitArea}
                  disabled={!ready || state.phase === 'loading'}
                >
                  <CrosshairIcon size={16} />
                  Fit area
                </Button>
              )}
            </section>
          </>
        )}
      </div>
      {tab === 'area' && (
        <footer className="analysis-panel-footer">
          {activeDraft ? (
            <Button
              type="button"
              className="analysis-confirm"
              disabled={
                !ready ||
                !state.draft ||
                Boolean(state.error) ||
                Boolean(loadingCountry) ||
                state.phase === 'drawing' ||
                state.phase === 'loading' ||
                (state.draft?.type === 'country' &&
                  !(
                    state.draft.sourceGeometry &&
                    state.draft.displayGeometry &&
                    state.draft.displayBoundary &&
                    state.draft.boundaryRef
                  ))
              }
              onClick={() => {
                onConfirm()
                setTab('activity')
              }}
            >
              <CheckCircleIcon size={18} />
              Use this area
            </Button>
          ) : (
            area && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setMethod(area.type === 'country' ? 'country' : 'draw')
                  if (area.type === 'country') {
                    setQuery('')
                    onCancel()
                    onPickingChange(true)
                  } else onEdit()
                }}
              >
                {area.type === 'country' ? 'Replace country' : 'Edit area'}
              </Button>
            )
          )}
          {(state.confirmed || state.draft || state.phase !== 'idle' || picking) && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setQuery('')
                onClear()
              }}
            >
              <ArrowCounterClockwiseIcon size={16} />
              Clear area
            </Button>
          )}
        </footer>
      )}
    </aside>
  )
}
