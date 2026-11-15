import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button } from './ui/button'
import {
  investigationKey,
  type InvestigationScope,
  type ObservationFilters,
} from '@/lib/investigation'
import {
  scopeObservationOptions,
  type CanonicalObservation,
  type ObservationPage,
} from '@/lib/analytics-investigation'
import {
  fetchObservationPage,
  exportInvestigation,
  observationPageMatchesScope,
  ObservationRequestError,
} from '@/lib/observation-client'
import { firePlatformLabel, formatFireTime } from '@/lib/fire-severity'

export function RecordsExplorer({
  scope,
  active = true,
  onScopeChange,
  onHighlight,
  onResponse,
  onReturnToMap,
  onStatus,
}: {
  scope: InvestigationScope
  active?: boolean
  onScopeChange: (scope: InvestigationScope) => void
  onHighlight?: (scope: InvestigationScope) => void
  onResponse: (page: ObservationPage) => void
  onReturnToMap: () => void
  onStatus?: (loading: boolean, error: string) => void
}) {
  const [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(25)
  const [sort, setSort] = useState('newest'),
    [groupBy, setGroupBy] = useState('none')
  const [selected, setSelected] = useState<CanonicalObservation | null>(null)
  const [exporting, setExporting] = useState(''),
    [exportError, setExportError] = useState('')
  const [copyStatus, setCopyStatus] = useState('')
  const exportAbort = useRef<AbortController | null>(null)
  const identity = investigationKey(scope)
  const [previousIdentity, setPreviousIdentity] = useState(identity)
  if (identity !== previousIdentity) {
    setPreviousIdentity(identity)
    setPage(1)
    setSelected(null)
  }
  const options = scopeObservationOptions(scope, page, pageSize, sort, groupBy)
  const query = useQuery({
    queryKey: [
      'investigation-records',
      scope.query,
      scope.selection?.query,
      scope.selection?.global,
      options,
    ],
    queryFn: ({ signal }) => fetchObservationPage(scope, options, signal),
    retry: false,
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
  })
  const reportStatus = useEffectEvent((loading: boolean, error: string) =>
    onStatus?.(loading, error),
  )
  useEffect(
    () =>
      reportStatus(
        query.isFetching || query.isPending,
        query.error instanceof Error ? query.error.message : '',
      ),
    [query.isFetching, query.isPending, query.error],
  )
  const reportResponse = useEffectEvent((response: ObservationPage) => {
    if (observationPageMatchesScope(response, scope, options)) onResponse(response)
  })
  useEffect(() => {
    if (query.data && query.isSuccess && !query.isFetching) reportResponse(query.data)
  }, [query.data, query.isSuccess, query.isFetching])
  useEffect(() => () => exportAbort.current?.abort(), [identity, sort, groupBy])
  const data = query.data?.data
  const patch = (filters: ObservationFilters) => {
    onScopeChange({ ...scope, filters: { ...scope.filters, ...filters } })
    setPage(1)
  }
  const inputNumber = (
    key: 'frpMin' | 'frpMax' | 'modisConfidenceMin' | 'modisConfidenceMax',
    value: string,
  ) =>
    patch({
      [key]: value === '' ? undefined : Number(value),
      ...(key.startsWith('frp')
        ? { frpUnknown: undefined }
        : { viirsConfidence: undefined, modisConfidenceUnknown: undefined }),
    })
  async function download(format: 'csv' | 'geojson' | 'json') {
    exportAbort.current?.abort()
    const controller = new AbortController()
    exportAbort.current = controller
    setExporting(format)
    setExportError('')
    try {
      await exportInvestigation(scope, format, options, controller.signal)
    } catch (error) {
      if (!controller.signal.aborted)
        setExportError(error instanceof Error ? error.message : 'Export failed.')
    } finally {
      if (exportAbort.current === controller) {
        exportAbort.current = null
        setExporting('')
      }
    }
  }
  function inspect(row: CanonicalObservation) {
    setSelected(row)
    setCopyStatus('')
    onHighlight?.({ ...scope, filters: { ...scope.filters, observationId: row.id } })
  }
  const filters = scope.filters
  const platforms = scope.selection?.global
    ? ['terra', 'aqua', 'suomi-npp', 'noaa-20', 'noaa-21']
    : [...scope.query.filters.platforms]
  return (
    <section
      hidden={!active}
      className="area-analytics-card area-analytics-table-card analytics-records"
      aria-label="Complete observation explorer"
    >
      <div className="area-analytics-section-heading">
        <div>
          <h2>Detection records</h2>
          <p>
            {data
              ? `${data.total.toLocaleString()} matching observations out of ${data.summary.selectedCount.toLocaleString()} selected · ${data.summary.wholeAreaCount.toLocaleString()} in whole area`
              : 'Complete query-wide observations'}
          </p>
          <p className="area-analytics-footnote">
            Selected platforms: {platforms.map(firePlatformLabel).join(', ')}.
          </p>
        </div>
      </div>
      <div className="analytics-record-controls">
        <label className="analytics-record-search">
          Search
          <input
            type="search"
            maxLength={256}
            placeholder="Observation ID, satellite or product"
            value={filters.search ?? ''}
            onChange={(event) => patch({ search: event.currentTarget.value })}
          />
        </label>
        <label>
          Satellite
          <select
            value={filters.platform ?? ''}
            onChange={(e) => patch({ platform: e.currentTarget.value || undefined })}
          >
            <option value="">All satellites</option>
            {platforms.map((item) => (
              <option key={item} value={item}>
                {firePlatformLabel(item)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Product
          <input
            value={filters.source ?? ''}
            onChange={(e) => patch({ source: e.currentTarget.value || undefined })}
          />
        </label>
        <label>
          Day/night
          <select
            value={filters.dayNight ?? ''}
            onChange={(e) => patch({ dayNight: e.currentTarget.value || undefined })}
          >
            <option value="">All values</option>
            <option value="day">Day</option>
            <option value="night">Night</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
        <label>
          Acquired from (UTC)
          <input
            type="datetime-local"
            value={filters.acquiredStart?.slice(0, 16) ?? ''}
            onChange={(e) =>
              patch({
                acquiredStart: e.currentTarget.value ? `${e.currentTarget.value}:00Z` : undefined,
              })
            }
          />
        </label>
        <label>
          Acquired before (exclusive UTC)
          <input
            type="datetime-local"
            value={filters.acquiredEndExclusive?.slice(0, 16) ?? ''}
            onChange={(e) =>
              patch({
                acquiredEndExclusive: e.currentTarget.value
                  ? `${e.currentTarget.value}:00Z`
                  : undefined,
              })
            }
          />
        </label>
        <label>
          FRP min (MW)
          <input
            type="number"
            min={0}
            value={filters.frpMin ?? ''}
            onChange={(e) => inputNumber('frpMin', e.currentTarget.value)}
          />
        </label>
        <label>
          FRP max (MW)
          <input
            type="number"
            min={0}
            value={filters.frpMax ?? ''}
            onChange={(e) =>
              patch({
                frpMax: e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value),
                frpMaxExclusive: undefined,
                frpUnknown: undefined,
              })
            }
          />
        </label>
        <label>
          MODIS confidence min (0–100)
          <input
            type="number"
            min={0}
            max={100}
            value={filters.modisConfidenceMin ?? ''}
            onChange={(e) =>
              patch({
                modisConfidenceMin:
                  e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value),
                viirsConfidence: undefined,
                modisConfidenceUnknown: undefined,
              })
            }
          />
        </label>
        <label>
          MODIS confidence max (0–100)
          <input
            type="number"
            min={0}
            max={100}
            value={filters.modisConfidenceMax ?? ''}
            onChange={(event) => inputNumber('modisConfidenceMax', event.currentTarget.value)}
          />
        </label>
        <label className="analytics-checkbox-filter">
          <input
            type="checkbox"
            checked={filters.modisConfidenceUnknown ?? false}
            onChange={(event) =>
              patch({
                modisConfidenceUnknown: event.currentTarget.checked || undefined,
                modisConfidenceMin: undefined,
                modisConfidenceMax: undefined,
                viirsConfidence: undefined,
              })
            }
          />
          MODIS unknown confidence only
        </label>
        <label className="analytics-checkbox-filter">
          <input
            type="checkbox"
            checked={filters.frpUnknown ?? false}
            onChange={(event) =>
              patch({
                frpUnknown: event.currentTarget.checked || undefined,
                frpMin: undefined,
                frpMax: undefined,
                frpMaxExclusive: undefined,
              })
            }
          />
          Unknown FRP only
        </label>
        <label>
          VIIRS confidence
          <select
            value={filters.viirsConfidence?.[0] ?? ''}
            onChange={(e) =>
              patch({
                viirsConfidence: e.currentTarget.value ? [e.currentTarget.value] : undefined,
                modisConfidenceMin: undefined,
                modisConfidenceMax: undefined,
                modisConfidenceUnknown: undefined,
              })
            }
          >
            <option value="">All native values</option>
            {['low', 'nominal', 'high', 'unknown'].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Group by
          <select
            value={groupBy}
            onChange={(e) => {
              setGroupBy(e.currentTarget.value)
              setPage(1)
            }}
          >
            <option value="none">None</option>
            <option value="date">UTC date</option>
            <option value="hour">UTC date and hour</option>
            <option value="satellite">Satellite</option>
          </select>
        </label>
        <label>
          Sort
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.currentTarget.value)
              setPage(1)
            }}
          >
            <option value="newest">Newest acquisition first</option>
            <option value="oldest">Oldest acquisition first</option>
            <option value="frp">Highest reported FRP</option>
          </select>
        </label>
      </div>
      {query.isFetching && (
        <p role="status" className="area-analytics-loading">
          Loading matching observations…
        </p>
      )}
      {query.error && (
        <div role="alert" className="area-analytics-alert">
          <p>{query.error instanceof Error ? query.error.message : 'Observation query failed.'}</p>
          {!(
            query.error instanceof ObservationRequestError &&
            query.error.code === 'analysis-source-unavailable'
          ) && /expir|snapshot|source changed|no longer cached/i.test(String(query.error)) ? (
            <Button variant="outline" onClick={onReturnToMap}>
              Return to map and refresh selection
            </Button>
          ) : (
            <Button variant="outline" onClick={() => void query.refetch()}>
              Retry
            </Button>
          )}
        </div>
      )}
      {data?.total === 0 && (
        <p className="area-analytics-empty">No observations match this investigation.</p>
      )}
      {data && data.rows.length > 0 && (
        <div className="area-analytics-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Acquired UTC</th>
                <th>Satellite / sensor</th>
                <th>Native confidence</th>
                <th>FRP (MW)</th>
                <th>Day/night</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.flatMap((row, index) => {
                const group = data.groups.find((item) => item.key === row.groupKey)
                const heading =
                  groupBy !== 'none' &&
                  (index === 0 || data.rows[index - 1].groupKey !== row.groupKey)
                return [
                  heading ? (
                    <tr className="analytics-record-group" key={`group-${row.groupKey}`}>
                      <th colSpan={5}>
                        {group?.label ?? row.groupKey} · {group?.count} observations
                      </th>
                    </tr>
                  ) : null,
                  <tr key={row.id} aria-selected={selected?.id === row.id}>
                    <td>
                      <button
                        type="button"
                        className="analytics-record-link"
                        onClick={() => inspect(row)}
                      >
                        {formatFireTime(row.acquiredAt)}
                      </button>
                      <small>{row.id}</small>
                    </td>
                    <td>
                      {firePlatformLabel(row.platform)} / {row.sensor}
                    </td>
                    <td>
                      {row.confidence.value ?? 'Unknown'}
                      {row.sensor === 'MODIS' ? ' / 100' : ' (VIIRS class)'}
                    </td>
                    <td>{row.frpMw ?? 'Unknown'}</td>
                    <td>{row.dayNight}</td>
                  </tr>,
                ]
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="analytics-record-pagination">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1 || query.isFetching}
          onClick={() => setPage(page - 1)}
        >
          Previous
        </Button>
        <span>
          Page {page} of {Math.max(1, Math.ceil((data?.total ?? 0) / pageSize))}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={query.isFetching || page * pageSize >= (data?.total ?? 0)}
          onClick={() => setPage(page + 1)}
        >
          Next
        </Button>
        <label>
          Page size
          <select
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.currentTarget.value))
              setPage(1)
            }}
          >
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </label>
      </div>
      {selected && (
        <section className="analytics-record-detail" aria-label="Selected satellite observation">
          <div className="area-analytics-section-heading">
            <h3>Satellite observation</h3>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSelected(null)
                onHighlight?.(scope)
              }}
            >
              Return to records
            </Button>
          </div>
          <dl>
            {Object.entries({
              ID: selected.id,
              'Acquisition UTC': formatFireTime(selected.acquiredAt),
              'Sensor / satellite': `${selected.sensor} / ${firePlatformLabel(selected.platform)}`,
              Coordinates: `${selected.latitude}, ${selected.longitude}`,
              'Native confidence': `${selected.confidence.value ?? 'Unknown'} ${selected.confidence.unit ?? ''}`,
              'FRP (MW)': selected.frpMw ?? 'Unknown',
              'Day/night': selected.dayNight,
              'Scan × track (km)': `${selected.scanKm ?? 'Unknown'} × ${selected.trackKm ?? 'Unknown'}`,
            }).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <details>
            <summary>Scientific details and provenance</summary>
            <p>
              Reported native confidence:{' '}
              {selected.confidence.nativeValue ?? selected.confidence.value ?? 'Unknown'}.
            </p>
            <p>
              Source/product: {selected.sourceProduct ?? selected.provenance ?? 'Unknown'}.
              Processing tier: {selected.processingTier ?? 'Unknown'}. Version:{' '}
              {selected.productVersion ?? 'Unknown'}.
            </p>
            <p>
              Footprints approximate the reported sensor pixel around its canonical coordinate. They
              are not exact fire perimeters or burned area. Nominal sensor resolution:{' '}
              {selected.nominalResolutionM ?? 'Unknown'} m.
            </p>
          </details>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(`${selected.latitude}, ${selected.longitude}`)
                .then(
                  () => setCopyStatus('Copied coordinates'),
                  () => setCopyStatus('Select the coordinates to copy them.'),
                )
            }}
          >
            Copy coordinates
          </Button>
          <span role="status">{copyStatus}</span>
        </section>
      )}
      <div className="analytics-record-exports">
        {(['csv', 'geojson', 'json'] as const).map((format) => (
          <Button
            key={format}
            variant="outline"
            size="sm"
            disabled={!data || !!exporting || query.isFetching}
            onClick={() => void download(format)}
          >
            {exporting === format
              ? 'Exporting…'
              : format === 'json'
                ? 'Reproducibility manifest'
                : `Export matching ${format.toUpperCase()}`}
          </Button>
        ))}
      </div>
      {exportError && <p role="alert">{exportError}</p>}
    </section>
  )
}
