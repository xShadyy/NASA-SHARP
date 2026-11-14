import { useEffect, useEffectEvent, useId, useState, type RefObject } from 'react'
import { CropIcon, DownloadSimpleIcon } from '@phosphor-icons/react'
import { DraggablePanel } from '@/components/DraggablePanel'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { CaptureRegion, CaptureResult, CaptureSettings } from '@/lib/map-capture'
import './CapturePanel.css'

type CapturePanelProps = {
  containerRef: RefObject<HTMLElement | null>
  onClose: () => void
  onPreview: (settings: CaptureSettings) => Promise<CaptureResult>
  region?: CaptureRegion | null
  onSelectRegion?: () => void
  onClearRegion?: () => void
  captureReady?: boolean
}

const captureOptions = [
  { key: 'header', label: 'Header' },
  { key: 'timestamp', label: 'Timestamp' },
  { key: 'scalebar', label: 'Scalebar' },
] as const

export function CapturePanel({
  containerRef,
  onClose,
  onPreview,
  region,
  onSelectRegion,
  onClearRegion,
  captureReady = true,
}: CapturePanelProps) {
  const id = useId()
  const [options, setOptions] = useState({ header: true, timestamp: true, scalebar: true })
  const [format, setFormat] = useState<CaptureSettings['format']>('jpg')
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState('')
  const [images, setImages] = useState<{ preview: string; image: string } | null>(null)

  useEffect(() => {
    return () => {
      if (images) {
        URL.revokeObjectURL(images.preview)
        URL.revokeObjectURL(images.image)
      }
    }
  }, [images])

  const createPreview = useEffectEvent(onPreview)

  useEffect(() => {
    if (!captureReady) return
    let active = true
    const timer = setTimeout(() => {
      setCapturing(true)
      setError('')
      void createPreview({ format, ...options }).then(
        (result) => {
          if (active) {
            setImages({
              preview: URL.createObjectURL(result.preview),
              image: URL.createObjectURL(result.image),
            })
            setCapturing(false)
          }
        },
        (failure: unknown) => {
          if (active) {
            setError(
              failure instanceof Error
                ? failure.message
                : 'The image could not be captured. Please try again.',
            )
            setCapturing(false)
          }
        },
      )
    }, 0)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [captureReady, format, options, region])

  const download = () => {
    if (!images || capturing) return
    const link = document.createElement('a')
    link.href = images.image
    link.download = `sharp-${new Date().toISOString().replace(/[:.]/g, '-')}.${format}`
    document.body.append(link)
    link.click()
    link.remove()
  }

  return (
    <DraggablePanel
      id="capture-panel"
      title="CAPTURE"
      className="capture-panel"
      containerRef={containerRef}
      onClose={onClose}
      closeLabel="Close capture"
      dragLabel="Move capture window"
      initialPlacement="top-right"
    >
      {onSelectRegion && (
        <div className="capture-region-controls">
          <Button type="button" variant="outline" size="sm" onClick={onSelectRegion}>
            <CropIcon size={16} />
            {region ? 'Change area' : 'Select area'}
          </Button>
          {region ? (
            <>
              <span>
                {Math.round(region.width)} × {Math.round(region.height)} px
              </span>
              <Button type="button" variant="ghost" size="sm" onClick={onClearRegion}>
                Full map
              </Button>
            </>
          ) : (
            <span>Full map</span>
          )}
        </div>
      )}
      <div className="capture-form">
        <div className="capture-options" role="group" aria-label="Include in screenshot">
          {captureOptions.map(({ key, label }) => (
            <label className="capture-option" key={key} htmlFor={`${id}-${key}`}>
              <Checkbox
                id={`${id}-${key}`}
                checked={options[key]}
                onCheckedChange={(checked) =>
                  setOptions((current) => ({ ...current, [key]: checked === true }))
                }
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <div className="capture-actions">
          <Select
            value={format}
            onValueChange={(value) => {
              if (value === 'jpg' || value === 'png') setFormat(value)
            }}
          >
            <SelectTrigger className="capture-format-trigger" aria-label="Image format">
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              className="capture-format-options"
              align="start"
              side="bottom"
              avoidCollisions={false}
            >
              <SelectItem value="jpg">JPG</SelectItem>
              <SelectItem value="png">PNG</SelectItem>
            </SelectContent>
          </Select>
          <Button
            type="button"
            className="capture-download-button"
            disabled={capturing || !captureReady || !images || Boolean(error)}
            aria-busy={capturing}
            onClick={() => {
              void download()
            }}
          >
            <DownloadSimpleIcon size={18} aria-hidden="true" />
            Download image
          </Button>
        </div>
      </div>
      {images && (
        <figure className="capture-preview">
          <img src={images.preview} alt="Captured map area" draggable={false} />
          <figcaption>Preview</figcaption>
        </figure>
      )}
      {error && (
        <p className="capture-error" role="alert">
          {error}
        </p>
      )}
    </DraggablePanel>
  )
}
