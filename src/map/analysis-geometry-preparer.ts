import type { AreaGeometry } from '@/lib/analysis-area'
import { fallbackAnalysisDisplayGeometry, type AnalysisDisplayGeometry } from './analysis-geometry'

type GeometryWorker = Pick<
  Worker,
  'onmessage' | 'onerror' | 'onmessageerror' | 'postMessage' | 'terminate'
>

export function createAnalysisGeometryPreparer(
  createWorker: () => GeometryWorker = () =>
    new Worker(new URL('./analysis-geometry.worker.ts', import.meta.url), { type: 'module' }),
) {
  let revision = 0
  let disposed = false
  let worker: GeometryWorker | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let saved: { geometry: AreaGeometry; result: AnalysisDisplayGeometry } | null = null

  function release() {
    clearTimeout(timer)
    timer = undefined
    if (worker) {
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      worker.terminate()
      worker = null
    }
  }

  function cancel() {
    revision++
    release()
  }

  return {
    prepare(geometry: AreaGeometry, onReady: (result: AnalysisDisplayGeometry) => void) {
      cancel()
      if (disposed) return
      const current = revision
      if (saved?.geometry === geometry) {
        onReady(saved.result)
        return
      }
      saved = null
      const publish = (result: AnalysisDisplayGeometry) => {
        if (disposed || current !== revision) return
        release()
        saved = { geometry, result }
        onReady(result)
      }
      const fallback = () => {
        if (disposed || current !== revision) return
        release()
        timer = setTimeout(() => {
          timer = undefined
          if (!disposed && current === revision) publish(fallbackAnalysisDisplayGeometry(geometry))
        }, 0)
      }
      try {
        worker = createWorker()
        worker.onmessage = (
          event: MessageEvent<{ result?: AnalysisDisplayGeometry; error?: string }>,
        ) => {
          if (disposed || current !== revision) return
          if (event.data.result?.boundary && event.data.result.outside) publish(event.data.result)
          else fallback()
        }
        worker.onerror = fallback
        worker.onmessageerror = fallback
        timer = setTimeout(fallback, 60_000)
        worker.postMessage(geometry)
      } catch {
        fallback()
      }
    },
    cancel,
    destroy() {
      disposed = true
      cancel()
      saved = null
    },
  }
}
