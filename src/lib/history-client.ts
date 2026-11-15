import { investigationRequest, type InvestigationScope } from './investigation'

export type HistoricalPreparation = {
  state: string
  message?: string
  completed?: number
  total?: number
  active?: boolean
  explicitRetry?: boolean
  retryAfterSeconds?: number
}

export function readHistoricalSummary<T>(
  query: InvestigationScope['query'],
  options: Record<string, unknown>,
  signal: AbortSignal,
) {
  return investigationRequest<T>('history', query, options, signal)
}

export function readHistoricalPreparation(
  query: InvestigationScope['query'],
  options: Record<string, unknown>,
  signal: AbortSignal,
) {
  return investigationRequest<HistoricalPreparation>('history/status', query, options, signal)
}

export function startHistoricalPreparation(
  query: InvestigationScope['query'],
  options: Record<string, unknown>,
  signal: AbortSignal,
) {
  return investigationRequest<HistoricalPreparation>('history/prepare', query, options, signal)
}
