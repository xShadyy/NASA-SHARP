import type { AreaBounds, AreaGeometry } from '@/lib/analysis-area'
import { prepareCountryDisplayGeometry, type PreparedBoundaryGeometry } from './analysis-geometry'

type GeometryWorker = Pick<
  Worker,
  'onmessage' | 'onerror' | 'onmessageerror' | 'postMessage' | 'terminate'
>

type PreparationOptions = { signal?: AbortSignal; preferredBounds?: AreaBounds }

export function createBoundaryGeometryClient(
  createWorker: () => GeometryWorker = () =>
    new Worker(new URL('./analysis-geometry.worker.ts', import.meta.url), { type: 'module' }),
) {
  return (
    geometry: AreaGeometry,
    options: PreparationOptions = {},
  ): Promise<PreparedBoundaryGeometry> =>
    new Promise((resolve, reject) => {
      const signal = options.signal
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException('Boundary preparation canceled.', 'AbortError'))
        return
      }
      let worker: GeometryWorker | null = null
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        if (worker) {
          worker.onmessage = null
          worker.onerror = null
          worker.onmessageerror = null
          worker.terminate()
          worker = null
        }
      }
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const finish = (result: PreparedBoundaryGeometry) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(result)
      }
      const abort = () =>
        fail(signal?.reason ?? new DOMException('Boundary preparation canceled.', 'AbortError'))
      signal?.addEventListener('abort', abort, { once: true })
      try {
        worker = createWorker()
      } catch {
        timer = setTimeout(() => {
          if (settled) return
          try {
            finish(prepareCountryDisplayGeometry(geometry, options.preferredBounds))
          } catch (error) {
            fail(error)
          }
        }, 0)
        return
      }
      worker.onmessage = (
        event: MessageEvent<{ result?: PreparedBoundaryGeometry; error?: string }>,
      ) => {
        if (
          event.data.result?.displayGeometry &&
          event.data.result.displayBoundary &&
          event.data.result.bounds
        )
          finish(event.data.result)
        else fail(new Error(event.data.error || 'The country boundary could not be prepared.'))
      }
      worker.onerror = () =>
        fail(new Error('The country boundary worker failed. Try selecting it again.'))
      worker.onmessageerror = () =>
        fail(new Error('The country boundary worker returned an invalid result.'))
      timer = setTimeout(
        () => fail(new Error('Preparing the country boundary took too long. Try again.')),
        60_000,
      )
      try {
        worker.postMessage({ type: 'country', geometry, preferredBounds: options.preferredBounds })
      } catch (error) {
        fail(error)
      }
    })
}

export const prepareBoundaryGeometry = createBoundaryGeometryClient()
