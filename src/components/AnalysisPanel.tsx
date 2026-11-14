import { useDeferredValue, useId, useMemo, useRef, useState } from 'react'
import type { DateRange } from 'react-day-picker'
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
import { Calendar } from '@/components/ui/calendar'
import { Command, CommandItem, CommandList } from '@/components/ui/command'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { areaPolygons } from '@/lib/analysis-area'
import {
  MAX_ANALYSIS_DAYS,
  clampRange,
  formatUtcRange,
  pickerDateToUtcDay,
  utcDayToPickerDate,
  utcToday,
  type AnalysisRange,
} from '@/lib/analysis-activity'
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
  generation,
  onRangeChange,
  fireStatus,
  fireCount,
  fireMessage,
  onRetryFires,
}: AnalysisPanelProps) {
  const [tab, setTab] = useState<'area' | 'activity'>('area')
  const [calendarMonth, setCalendarMonth] = useState(() => range.start.slice(0, 7))
  const [trackedRangeStart, setTrackedRangeStart] = useState(range.start)
  const awaitingEnd = useRef(false)
  const writtenRange = useRef(range)
  if (writtenRange.current.start !== range.start || writtenRange.current.end !== range.end) {
    writtenRange.current = range
    awaitingEnd.current = false
  }
  if (range.start !== trackedRangeStart) {
    setTrackedRangeStart(range.start)
    setCalendarMonth(range.start.slice(0, 7))
  }

  function choosePeriodDay(triggerDate: Date) {
    const today = utcToday()
    const picked = pickerDateToUtcDay(triggerDate)
    const day = picked > today ? today : picked
    const next = awaitingEnd.current ? clampRange(range.start, day) : { start: day, end: day }
    awaitingEnd.current = !awaitingEnd.current
    writtenRange.current = next
    setCalendarMonth(day.slice(0, 7))
    onRangeChange(next)
  }
  const [method, setMethod] = useState<'country' | 'draw'>(() =>
    (state.draft ?? state.confirmed)?.type === 'country' || !(state.draft ?? state.confirmed)
      ? 'country'
      : 'draw',
  )
  const selectedCountry =
    state.pendingCountry ?? (state.draft?.type === 'country' ? state.draft : null)
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
          <h1 id={`${id}-title`}>Analysis</h1>
          <ToggleGroup
            type="single"
            value={tab}
            className="analysis-tabs"
            aria-label="Analysis sections"
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
          aria-label="Close Analysis"
          onClick={onClose}
        >
          <XIcon size={19} />
        </Button>
      </header>
      <div className="analysis-panel-body">
        {tab === 'activity' && !state.confirmed && (
          <p className="analysis-notice">Confirm an area to see activity.</p>
        )}
        {state.confirmed && (
          <div hidden={tab !== 'activity'}>
            <AnalysisActivity
              key={state.confirmed.id}
              area={state.confirmed}
              range={range}
              generation={generation}
              onRangeChange={onRangeChange}
            />
          </div>
        )}
        {tab === 'area' && (
          <>
            <section className="analysis-period" aria-labelledby={`${id}-period-title`}>
              <h2 id={`${id}-period-title`}>Period</h2>
              <p className="analysis-intro">
                Choose the dates before confirming the area. Click one day, or a second day for a
                period of up to {MAX_ANALYSIS_DAYS} days.
              </p>
              <p className="analysis-period-selection">{formatUtcRange(range)}</p>
              <Calendar
                mode="range"
                required
                excludeDisabled
                selected={{
                  from: utcDayToPickerDate(range.start),
                  to: utcDayToPickerDate(range.end),
                }}
                month={utcDayToPickerDate(`${calendarMonth}-01`)}
                onMonthChange={(date) => setCalendarMonth(pickerDateToUtcDay(date).slice(0, 7))}
                disabled={{ after: utcDayToPickerDate(utcToday()) }}
                onSelect={(_selected: DateRange, triggerDate) => choosePeriodDay(triggerDate)}
                className="analysis-period-calendar"
              />
              <ul className="fire-legend" aria-label="Fire severity">
                {FIRE_LEVELS.map((level) => (
                  <li key={level.id}>
                    <span className="fire-swatch" style={{ background: level.color }} />
                    <span>
                      {level.label}
                      <small>{level.detail}</small>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="analysis-period-note">
                Colors follow fire radiative power. A detection without it is shown in yellow.
              </p>
              {fireStatus === 'loading' && (
                <p className="analysis-notice" role="status">
                  Loading fires for this period.
                </p>
              )}
              {fireStatus === 'ready' && (
                <p className="analysis-notice" role="status">
                  {fireCount === 1 ? '1 fire on the map.' : `${fireCount} fires on the map.`}
                </p>
              )}
              {fireStatus === 'error' && (
                <div className="analysis-error" role="alert">
                  <p>{fireMessage}</p>
                  {!fireMessage.includes('180°') && (
                    <Button type="button" size="sm" variant="outline" onClick={onRetryFires}>
                      Retry fires
                    </Button>
                  )}
                </div>
              )}
              {fireStatus === 'idle' && (
                <p className="analysis-period-note">
                  Confirm the area to show its fires on the map for this period.
                </p>
              )}
            </section>
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

              {method === 'country' ? (
                <div className="analysis-country-section">
                  <span className="analysis-field-label">Country</span>
                  <Button
                    type="button"
                    variant="outline"
                    className="analysis-map-pick"
                    aria-pressed={picking}
                    disabled={!ready || catalogueLoading || Boolean(catalogueError)}
                    onClick={() => onPickingChange(!picking)}
                  >
                    <CrosshairIcon size={18} />
                    {picking ? 'Selecting on map' : 'Select on map'}
                  </Button>
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
                  {state.phase === 'loading'
                    ? state.confirmed
                      ? 'Loading the full country boundary. Your confirmed area stays selected.'
                      : 'Loading the full country boundary before confirmation.'
                    : state.phase === 'drawing'
                      ? 'Your boundary will appear here when the drawing is complete.'
                      : 'Select a country or draw a polygon or rectangle on the map.'}
                </p>
              )}
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
              {!activeDraft && state.confirmed && (
                <p className="analysis-confirmed-note">
                  Area confirmed. Fires for this period are on the map, and Activity uses the same
                  dates.
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
