import { useId } from 'react'
import { CaretDownIcon, StackIcon, XIcon } from '@phosphor-icons/react'
import { BackgroundSelector } from '@/components/BackgroundSelector'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import type { OverlayStatus } from '@/map/non-fire-overlays'
import type { MapBackground, MapReferenceLayers, ReferenceLayerAvailability } from '@/map/basemaps'
import './LayerSettings.css'

type ReferenceKey = keyof MapReferenceLayers
export type MapLayersControlProps = {
  background: MapBackground
  onBackgroundChange: (background: MapBackground) => void
  referenceLayers: MapReferenceLayers
  onReferenceChange: (key: ReferenceKey, value: boolean) => void
  availability: ReferenceLayerAvailability | null
  overlayStatus: OverlayStatus
  onOverlayRetry: () => void
  showSpace: boolean
  onSpaceChange: (value: boolean) => void
}

const referenceOptions: { key: ReferenceKey, label: string, description: string }[] = [
  { key: 'showGraticule', label: 'Latitude / longitude grid', description: 'Degree lines and labels; spacing adjusts as you zoom.' },
  { key: 'showCoastlines', label: 'Coastlines', description: 'Natural Earth generalized coastlines at overview zooms. Detailed water edges belong to the base map.' },
  { key: 'showBorders', label: 'Country borders', description: 'International boundaries, with disputed borders dashed.' },
  { key: 'showLabels', label: 'Geographic labels', description: 'Countries, continents, oceans and seas.' },
  { key: 'showCities', label: 'Major cities', description: 'Ranked cities visible before local towns and roads.' },
  { key: 'showRoads', label: 'Roads', description: 'Major routes, then local streets as you zoom in.' },
  { key: 'showSettlements', label: 'Settlements', description: 'Local towns, villages and building footprints.' },
  { key: 'showTerrain', label: 'Terrain', description: 'Hillshade and land-cover shading in detailed map views.' },
]

const contextOptions: { key: ReferenceKey, label: string, description: string, statusKey?: keyof OverlayStatus }[] = [
  { key: 'showProtectedAreas', label: 'Protected areas', description: 'UNEP-WCMC / IUCN WDPA; latest protected-area release, verified October 2026.' },
  { key: 'showEuropeanProtectedAreas', label: 'European protected areas', description: 'EEA Natura 2000 sites; Europe only, visible from global views.', statusKey: 'showEuropeanProtectedAreas' },
  { key: 'showBuiltUp', label: 'Human built-up extent', description: 'NASA HBASE Landsat settlement class, 2010.', statusKey: 'showBuiltUp' },
  { key: 'showVolcanoes', label: 'Known volcanoes', description: 'Smithsonian Holocene locations; these are not active eruptions.' },
  { key: 'showLandsat8Swaths', label: 'Landsat 8 scene footprints', description: 'HLS L30 archive footprints for the selected date and visible region.', statusKey: 'showLandsat8Swaths' },
  { key: 'showLandsat9Swaths', label: 'Landsat 9 scene footprints', description: 'HLS L30 archive footprints for the selected date and visible region.', statusKey: 'showLandsat9Swaths' },
]

function visibilityHint(key: ReferenceKey, availability: ReferenceLayerAvailability | null, enabled: boolean) {
  if (!enabled || !availability || (key !== 'showRoads' && key !== 'showSettlements')) return null
  const status = availability[key === 'showRoads' ? 'roads' : 'settlements']
  if (!status.available) return 'Unavailable in this base map'
  if (status.visibleAtCurrentZoom) return null
  return key === 'showRoads' ? 'Zoom in to see roads' : 'Zoom in to see settlements'
}

function ReferenceRow({ option, checked, onChange, availability, status }: {
  option: { key: ReferenceKey, label: string, description: string }, checked: boolean, onChange: (checked: boolean) => void,
  availability: ReferenceLayerAvailability | null, status?: string,
}) {
  const id = useId()
  const hint = visibilityHint(option.key, availability, checked)
  return <div className="layer-setting-row">
    <Checkbox id={id} checked={checked} onCheckedChange={(value) => onChange(value === true)} aria-labelledby={`${id}-label`} aria-describedby={`${id}-description`} />
    <label htmlFor={id}>
      <span id={`${id}-label`}>{option.label}</span>
      <small id={`${id}-description`}>{checked && status ? status : hint ?? option.description}</small>
    </label>
  </div>
}

export function MapLayersControl({ background, onBackgroundChange, referenceLayers, onReferenceChange, availability, showSpace, onSpaceChange, overlayStatus, onOverlayRetry }: MapLayersControlProps) {
  const skyId = useId()
  const titleId = useId()
  const failedOverlay = Object.values(overlayStatus).some((value) => value?.includes('failed') || value?.includes('timed out'))
  return <Popover>
    <PopoverTrigger asChild><Button type="button" variant="outline" className="map-layers-trigger" aria-label="Map & layers"><StackIcon size={15} aria-hidden="true" /><span>Map & layers</span><CaretDownIcon size={14} aria-hidden="true" /></Button></PopoverTrigger>
    <PopoverContent side="bottom" align="end" collisionPadding={10} className="map-layers-panel" aria-labelledby={titleId}>
      <header className="map-layers-header"><h2 id={titleId}>Map & layers</h2><PopoverClose asChild><Button type="button" variant="ghost" size="icon-sm" className="map-layers-close" aria-label="Close map and layers"><XIcon size={15} /></Button></PopoverClose></header>
      <div className="map-layers-scroll">
        <fieldset>
          <legend>Base map</legend>
          <BackgroundSelector value={background} onValueChange={onBackgroundChange} label="Base map" />
        </fieldset>
        <Separator />
        <fieldset>
          <legend>Reference layers</legend>
          {referenceOptions.map((option) => <ReferenceRow key={option.key} option={option} checked={referenceLayers[option.key]} onChange={(value) => onReferenceChange(option.key, value)} availability={availability} />)}
        </fieldset>
        <Separator />
        <fieldset>
          <legend>Context overlays</legend>
          {contextOptions.map((option) => <ReferenceRow key={option.key} option={option} checked={referenceLayers[option.key]} onChange={(value) => onReferenceChange(option.key, value)} availability={availability} status={option.statusKey ? overlayStatus[option.statusKey] : undefined} />)}
          {failedOverlay && <Button type="button" size="sm" variant="outline" onClick={onOverlayRetry}>Retry overlays</Button>}
        </fieldset>
        <Separator />
        <fieldset>
          <legend>Space background</legend>
          <div className="layer-setting-row">
            <Checkbox id={skyId} checked={showSpace} onCheckedChange={(value) => onSpaceChange(value === true)} aria-describedby={`${skyId}-description`} />
            <label htmlFor={skyId}><span>Star map</span><small id={`${skyId}-description`}>NASA star-map imagery in Globe mode only.</small></label>
          </div>
        </fieldset>
      </div>
    </PopoverContent>
  </Popover>
}
