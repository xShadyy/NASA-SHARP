import { useEffect, useState } from 'react'
import type { AnalysisArea } from '@/lib/analysis-area'
import { fetchAnalysisFires } from '@/lib/analysis-api'
import { crossesDateline, type AnalysisRange } from '@/lib/analysis-activity'
import type { FireFeature } from '@/lib/fire-severity'

export type AnalysisFireStatus = 'idle' | 'loading' | 'ready' | 'error'

export function useAnalysisFires(area: AnalysisArea | null, range: AnalysisRange) {
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState<AnalysisFireStatus>('idle')
  const [features, setFeatures] = useState<FireFeature[]>([])
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!area) {
      setStatus('idle')
      setFeatures([])
      setMessage('')
      return
    }
    if (crossesDateline(area.fullBounds ?? area.bounds)) {
      setStatus('error')
      setFeatures([])
      setMessage(
        'This area crosses 180° longitude, so the live query cannot bound it. Draw the part you want on one side of the date line.',
      )
      return
    }
    const controller = new AbortController()
    setStatus('loading')
    setFeatures([])
    setMessage('')
    fetchAnalysisFires(area.id, area.geometry, range.start, range.end, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return
        setFeatures(next)
        setStatus('ready')
      })
      .catch((error: unknown) => {
        if (
          controller.signal.aborted ||
          (error instanceof DOMException && error.name === 'AbortError')
        )
          return
        setFeatures([])
        setStatus('error')
        setMessage(error instanceof Error ? error.message : 'Fires could not be loaded.')
      })
    return () => controller.abort()
  }, [area, range.start, range.end, attempt])

  return {
    status,
    features,
    message,
    count: features.length,
    retry: () => setAttempt((current) => current + 1),
  }
}
