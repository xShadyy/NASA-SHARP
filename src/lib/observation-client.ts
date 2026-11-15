import { apiUrl } from './api-config'
import { downloadBlob, type InvestigationScope } from './investigation'
import { scopeExportIdentity, type ObservationPage } from './analytics-investigation'

export type AnalysisSourceRecovery = {
  query: InvestigationScope['query']
  metadata: ObservationPage['meta']
  previousGeneration?: string
}

const recoveryListeners = new Set<(recovery: AnalysisSourceRecovery) => void>()
const pageRequests = new WeakMap<ObservationPage, string>()

export function subscribeAnalysisSourceRecovery(
  listener: (recovery: AnalysisSourceRecovery) => void,
) {
  recoveryListeners.add(listener)
  return () => {
    recoveryListeners.delete(listener)
  }
}

export class ObservationRequestError extends Error {
  readonly status: number
  readonly code: string
  readonly recoverable: boolean
  readonly action: string

  constructor(response: Response, body: Record<string, unknown> | null) {
    super(
      typeof body?.message === 'string'
        ? body.message
        : typeof body?.detail === 'string'
          ? body.detail
          : `Observation request failed (${response.status}).`,
    )
    this.name = 'ObservationRequestError'
    this.status = response.status
    this.code = typeof body?.code === 'string' ? body.code : ''
    this.recoverable = body?.recoverable === true
    this.action = typeof body?.action === 'string' ? body.action : ''
  }
}

export function requiresObservationReselection(error: unknown) {
  return (
    error instanceof ObservationRequestError &&
    (error.action === 'refresh-selected-group' ||
      ['selection-expired', 'selection-source-changed', 'selection-scope-mismatch'].includes(
        error.code,
      ) ||
      ((error.status === 409 || error.status === 410) &&
        /expired|snapshot|source changed|no longer cached/i.test(error.message)))
  )
}

export function investigationExportFilename(
  scope: InvestigationScope,
  format: 'csv' | 'geojson' | 'json',
) {
  const area =
    scope.area.name
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80)
      .toLowerCase() || 'selected-area'
  return `sharp-${area}-${scope.range.start}-${scope.range.end}.${format}`
}

function requestBody(scope: InvestigationScope, options: Record<string, unknown>) {
  const global = scope.selection?.global
  return global
    ? {
        snapshotId: global.snapshotId,
        window: global.window,
        aggregateId: global.aggregateId,
        interval: scope.query.interval,
        options,
      }
    : { query: scope.selection?.query ?? scope.query, options }
}

export function observationPageMatchesScope(
  page: ObservationPage,
  scope: InvestigationScope,
  options: Record<string, unknown>,
) {
  const identity = pageRequests.get(page)
  return identity === undefined || identity === JSON.stringify(requestBody(scope, options))
}

function isWholeAreaSource(scope: InvestigationScope, options: Record<string, unknown>) {
  return (
    !scope.selection?.global &&
    !scope.selection?.selectionToken &&
    !scope.selection?.observationIds?.length &&
    !options.selectionToken &&
    (Array.isArray(options.observationIds)
      ? options.observationIds.length === 0
      : !options.observationIds)
  )
}

function shouldPrepareSource(scope: InvestigationScope, options: Record<string, unknown>) {
  return (
    isWholeAreaSource(scope, options) &&
    options.sourceGeneration == null &&
    scope.selection?.sourceGeneration == null &&
    scope.metadata?.sourceGeneration == null
  )
}

function canRecoverSource(
  scope: InvestigationScope,
  options: Record<string, unknown>,
  error: ObservationRequestError,
) {
  return (
    error.status === 409 &&
    error.code === 'analysis-source-unavailable' &&
    error.recoverable &&
    isWholeAreaSource(scope, options)
  )
}

async function observationRequest(
  scope: InvestigationScope,
  options: Record<string, unknown>,
  signal?: AbortSignal,
  recoverSource = false,
) {
  signal?.throwIfAborted()
  const response = await fetch(
    apiUrl(scope.selection?.global ? '/global/observations' : '/analysis/observations'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        ...requestBody(scope, options),
        ...(recoverSource ? { recoverSource: true } : {}),
      }),
    },
  )
  const body = await response.json().catch(() => null)
  signal?.throwIfAborted()
  if (!response.ok) throw new ObservationRequestError(response, body)
  const page = body as ObservationPage
  pageRequests.set(page, JSON.stringify(requestBody(scope, options)))
  return page
}

function publishRecovery(scope: InvestigationScope, page: ObservationPage) {
  const recovery = {
    query: scope.selection?.query ?? scope.query,
    metadata: page.meta,
    previousGeneration: scope.selection?.sourceGeneration ?? scope.metadata?.sourceGeneration,
  }
  for (const listener of recoveryListeners) listener(recovery)
}

export async function fetchObservationPage(
  scope: InvestigationScope,
  options: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ObservationPage> {
  if (shouldPrepareSource(scope, options)) {
    const page = await observationRequest(scope, options, signal, true)
    signal.throwIfAborted()
    publishRecovery(scope, page)
    return page
  }
  try {
    return await observationRequest(scope, options, signal)
  } catch (error) {
    signal.throwIfAborted()
    if (!(error instanceof ObservationRequestError) || !canRecoverSource(scope, options, error))
      throw error
  }
  const page = await observationRequest(scope, options, signal, true)
  signal.throwIfAborted()
  publishRecovery(scope, page)
  return page
}

export async function exportInvestigation(
  scope: InvestigationScope,
  format: 'csv' | 'geojson' | 'json',
  options: Record<string, unknown>,
  signal?: AbortSignal,
) {
  let exportScope = scope
  let exportOptions = options
  let recoveryPage: ObservationPage | null = null
  async function prepareExportSource() {
    const recovered = await observationRequest(
      exportScope,
      { ...exportOptions, page: 1, pageSize: 1 },
      signal,
      true,
    )
    signal?.throwIfAborted()
    exportScope = {
      ...exportScope,
      metadata: { ...exportScope.metadata, ...recovered.meta },
      selection: exportScope.selection
        ? { ...exportScope.selection, sourceGeneration: recovered.meta.sourceGeneration }
        : undefined,
    }
    exportOptions = { ...exportOptions, sourceGeneration: recovered.meta.sourceGeneration }
    recoveryPage = recovered
  }
  if (shouldPrepareSource(exportScope, exportOptions)) await prepareExportSource()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    signal?.throwIfAborted()
    const response = await fetch(
      apiUrl(
        exportScope.selection?.global
          ? '/global/observations/export'
          : '/analysis/observations/export',
      ),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          ...requestBody(exportScope, exportOptions),
          format,
          investigation: scopeExportIdentity(exportScope),
        }),
      },
    )
    if (response.ok) {
      const blob = await response.blob()
      signal?.throwIfAborted()
      downloadBlob(blob, investigationExportFilename(exportScope, format))
      if (recoveryPage) publishRecovery(scope, recoveryPage)
      return
    }
    const body = await response.json().catch(() => null)
    signal?.throwIfAborted()
    const error = new ObservationRequestError(response, body)
    if (recoveryPage || attempt > 0 || !canRecoverSource(exportScope, exportOptions, error))
      throw error
    await prepareExportSource()
  }
}
