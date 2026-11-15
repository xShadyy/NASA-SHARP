export type GlobalStartupState = {
  ready: boolean
  phase: 'fetching' | 'rendering'
  error: string
}

export const GLOBAL_STARTUP_TIMEOUT_MS = 30_000


export function mergeGlobalStartupState(
  current: GlobalStartupState,
  next: GlobalStartupState,
): GlobalStartupState {
  if (current.ready) return current
  const merged =
    current.error && !next.ready && !next.error ? { ...next, error: current.error } : next
  return current.ready === merged.ready &&
    current.phase === merged.phase &&
    current.error === merged.error
    ? current
    : merged
}
