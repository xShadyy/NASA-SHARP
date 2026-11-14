import { useId, useState, type RefObject } from 'react'
import { CropIcon, DownloadSimpleIcon } from '@phosphor-icons/react'
import { DraggablePanel } from '@/components/DraggablePanel'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { CaptureRegion, CaptureSettings } from '@/lib/map-capture'
import './CapturePanel.css'

type CapturePanelProps = {
  containerRef: RefObject<HTMLElement | null>
  onClose: () => void
  onCapture: (settings: CaptureSettings) => Promise<void>
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

export function CapturePanel({ containerRef, onClose, onCapture, region, onSelectRegion, onClearRegion, captureReady = true }: CapturePanelProps) {
  const id = useId()
  const [options, setOptions] = useState({ header: true, timestamp: true, scalebar: true })
  const [format, setFormat] = useState<CaptureSettings['format']>('jpg')
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState('')

  const download = async () => {
    if (capturing || !captureReady) return
    setCapturing(true)
    setError('')
    try { await onCapture({ format, ...options }) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'The image could not be downloaded. Please try again.') }
    finally { setCapturing(false) }
  }

  return <DraggablePanel
    id="capture-panel"
    title="CAPTURE"
    className="capture-panel"
    containerRef={containerRef}
    onClose={onClose}
    closeLabel="Close capture"
    dragLabel="Move capture window"
    initialPlacement="top-right"
  >
    <p className="capture-description">Download the map as an image.</p>
    {onSelectRegion && <div className="capture-region-controls">
      <Button type="button" variant="outline" size="sm" disabled={capturing} onClick={onSelectRegion}><CropIcon size={15} />{region ? 'Change area' : 'Select area'}</Button>
      {region ? <><span>{Math.round(region.width)} × {Math.round(region.height)} px</span><Button type="button" variant="ghost" size="sm" disabled={capturing} onClick={onClearRegion}>Full map</Button></> : <span>Full map</span>}
    </div>}
    <div className="capture-form">
      <div className="capture-options" role="group" aria-label="Include in screenshot">
        {captureOptions.map(({ key, label }) => <label className="capture-option" key={key} htmlFor={`${id}-${key}`}>
          <Checkbox
            id={`${id}-${key}`}
            checked={options[key]}
            disabled={capturing}
            onCheckedChange={(checked) => setOptions((current) => ({ ...current, [key]: checked === true }))}
          />
          <span>{label}</span>
        </label>)}
      </div>
      <div className="capture-actions">
        <Select value={format} onValueChange={(value) => { if (value === 'jpg' || value === 'png') setFormat(value) }} disabled={capturing}>
          <SelectTrigger className="capture-format-trigger" aria-label="Image format">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="capture-format-options" align="start" side="bottom" avoidCollisions={false}>
            <SelectItem value="jpg">JPG</SelectItem>
            <SelectItem value="png">PNG</SelectItem>
          </SelectContent>
        </Select>
        <Button type="button" className="capture-download-button" disabled={capturing || !captureReady} onClick={() => { void download() }}>
          <DownloadSimpleIcon size={18} aria-hidden="true" />
          {capturing ? 'Preparing…' : 'Download image'}
        </Button>
      </div>
    </div>
    {error && <p className="capture-error" role="alert">{error}</p>}
  </DraggablePanel>
}
