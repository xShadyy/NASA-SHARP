import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { MantineProvider } from '@mantine/core'
import { CalendarDotsIcon, GlobeHemisphereWestIcon, InfoIcon, MoonIcon, SunIcon, CrosshairIcon, MinusIcon, PlusIcon } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger, useSidebar } from '@/components/ui/sidebar'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CurrentLocationButton, DestinationSearch } from '@/components/DestinationSearch'
import { ButtonGroup } from '@/components/ui/button-group'
import type { EarthMapHandle, MapCameraState } from '@/components/EarthMap'
import type { LocationTarget } from '@/lib/locations' 
import { MapCredits } from '@/components/MapCredits'
import { selectedDataDate } from '@/lib/data-date'
import { DEFAULT_MAP_BACKGROUND, DEFAULT_REFERENCE_LAYERS, isMapBackground, type MapBackground, type MapReferenceLayers } from '@/map/basemaps' 
import './App.css'
import './components/sidebar.css'

type DatePeriod = '24 hours' | '7 days' | '30 days'
const mantineTheme = { fontFamily: '"Fira Sans", sans-serif', fontFamilyMonospace: '"Fira Sans", sans-serif' }
const EarthMap = lazy(() => import('@/components/EarthMap').then((module) => ({ default: module.EarthMap })))
const LAYER_STORAGE_KEY = 'ethereal-map-layers-v1'
function loadReferenceLayers(): MapReferenceLayers {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYER_STORAGE_KEY) ?? '{}')
    return { ...DEFAULT_REFERENCE_LAYERS, ...Object.fromEntries(Object.keys(DEFAULT_REFERENCE_LAYERS).filter((key) => typeof saved[key] === 'boolean').map((key) => [key, saved[key]])) }
  } catch { return { ...DEFAULT_REFERENCE_LAYERS } }
}

function ExplorerSidebar() {
  const { open, setOpen, isMobile, openMobile, setOpenMobile } = useSidebar()
  const expanded = isMobile ? openMobile : open
  function openGuide() {
    if (isMobile) setOpenMobile(true)
    else setOpen(true)
  }
  return <Sidebar id="explorer-sidebar" collapsible="icon" aria-label="Explorer navigation">
    <SidebarHeader><span className="sidebar-title">Ethereal</span><SidebarTrigger className="sidebar-collapse-trigger" /><Separator className="rail-separator" /></SidebarHeader>
    <SidebarContent>{expanded && <section className="sidebar-help" aria-label="Instructions" tabIndex={0}>
      <span className="sidebar-help-kicker">EXPLORER GUIDE</span><h2>Explore Earth</h2>
      <p>Choose a reference date and time range using the calendar. Today returns the reference date to the current day. Switch between light and dark themes using the top-right control.</p>
      <p>Left-drag to explore Earth and scroll or pinch to zoom. Switch between Globe and Map using the upper-left control. Search for a country, city or coordinates, use your current location, or reset the map using the bottom toolbar.</p><p>Open Map &amp; layers at the upper-right to choose a base map, geographic reference layers, context overlays or the star-map background. Hover over Earth to inspect coordinates. The scale bars display both kilometers and miles.</p><MapCredits />
    </section>}</SidebarContent>
    <SidebarFooter><SidebarMenu><SidebarMenuItem><SidebarMenuButton className="rail-button" aria-label="Instructions" onClick={openGuide}><InfoIcon size={20} /><span className="sidebar-item-label">Instructions</span></SidebarMenuButton></SidebarMenuItem></SidebarMenu></SidebarFooter>
  </Sidebar>
}

function formatDate(value: Date | undefined) {
  return value ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(value) : 'Choose date'
}

function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try { return localStorage.getItem('wildfire-theme') === 'dark' ? 'dark' : 'light' }
    catch { return 'light' }
  })
  const [date, setDate] = useState<Date | undefined>(() => new Date())
  const [calendarMonth, setCalendarMonth] = useState(() => new Date())
  const [period, setPeriod] = useState<DatePeriod>('24 hours')
  const themeAction = theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'
  const mapRef = useRef<EarthMapHandle>(null)
  const [camera, setCamera] = useState<MapCameraState>({ ready: false, zoom: 1, minZoom: -1, maxZoom: 18, longitude: 18, latitude: 12, view: 'globe' })
  const [destination, setDestination] = useState<LocationTarget | null>(null)
  const [navigationRequest, setNavigationRequest] = useState(0)
  function selectDestination(location: LocationTarget) {
    setDestination(location)
    setNavigationRequest((current) => current + 1)
  }
  const [referenceLayers, setReferenceLayers] = useState<MapReferenceLayers>(loadReferenceLayers)
  const [background, setBackground] = useState<MapBackground>(() => {
    try { const saved = localStorage.getItem('ethereal-map-background-v1'); return isMapBackground(saved) ? saved : DEFAULT_MAP_BACKGROUND }
    catch { return DEFAULT_MAP_BACKGROUND }
  })
  const [showSpace, setShowSpace] = useState(() => {
    try { return JSON.parse(localStorage.getItem(LAYER_STORAGE_KEY) ?? '{}').space !== false }
    catch { return true }
  })
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try { localStorage.setItem('wildfire-theme', theme) }
    catch { /* The selected theme still works without browser storage. */ }
  }, [theme])
  useEffect(() => {
    try { localStorage.setItem(LAYER_STORAGE_KEY, JSON.stringify({ ...referenceLayers, space: showSpace })) }
    catch { /* Layer choices still work for this session. */ }
  }, [referenceLayers, showSpace])
  useEffect(() => {
    try { localStorage.setItem('ethereal-map-background-v1', background) }
    catch { /* Background choices still work for this session. */ }
  }, [background])

  return <MantineProvider theme={mantineTheme} forceColorScheme={theme}><TooltipProvider>
    <div className="app-shell">
      <header className="app-header">
        <div className="header-brand" aria-label="Ethereal wildfire explorer"><span className="brand-symbol"><GlobeHemisphereWestIcon size={19} /></span><span>ETHEREAL <span className="brand-suffix">/ OUR TOOL NAME</span></span></div>
        <DestinationSearch onSelect={selectDestination} />
        <div className="header-actions">
          <Popover>
            <PopoverTrigger asChild><Button type="button" variant="outline" className="date-control" aria-label="Choose reference date and time range"><CalendarDotsIcon size={16} /><span className="date-label">{formatDate(date)}</span><span className="date-divider">·</span><span className="period-label">{period}</span></Button></PopoverTrigger>
            <PopoverContent align="center" side="bottom" collisionPadding={8} className="date-popover">
              <Calendar mode="single" fixedWeeks selected={date} month={calendarMonth} onMonthChange={setCalendarMonth} onSelect={(selected) => { setDate(selected); if (selected) setCalendarMonth(selected) }} timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone} className="calendar-picker" />
              <Separator className="date-range-divider" />
              <div className="date-range-actions">
                <ToggleGroup type="single" className="date-range-options" value={period} onValueChange={(value) => { if (value === '24 hours' || value === '7 days' || value === '30 days') setPeriod(value) }} aria-label="Time range">
                  {[['24 hours', '24h'], ['7 days', '7d'], ['30 days', '30d']].map(([value, label]) => <ToggleGroupItem key={value} value={value} aria-label={value}>{label}</ToggleGroupItem>)}
                </ToggleGroup>
                <Button type="button" variant="ghost" size="sm" className="date-reset" onClick={() => { const today = new Date(); setDate(today); setCalendarMonth(today) }}>Today</Button>
              </div>
            </PopoverContent>
          </Popover>
          <Button type="button" variant="outline" size="icon" className="theme-toggle" aria-label={themeAction} onClick={() => setTheme((current) => current === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <MoonIcon size={18} /> : <SunIcon size={18} />}</Button>
        </div>
      </header>
      <SidebarProvider defaultOpen={false} className="app-body"><ExplorerSidebar />
        <main className="explorer-stage" aria-label="Global Earth explorer">
          <Suspense fallback={<div className="map-loading" role="status">Loading map…</div>}><EarthMap ref={mapRef} destination={destination} navigationRequest={navigationRequest} onCameraChange={setCamera} dataDate={selectedDataDate(date)} referenceLayers={referenceLayers} onReferenceChange={(key, value) => setReferenceLayers((current) => ({ ...current, [key]: value }))} background={background} onBackgroundChange={setBackground} showSpace={showSpace} onSpaceChange={setShowSpace} /></Suspense>
          <div className="globe-tools"><div className="bottom-toolbar" aria-label="Globe tools"><ButtonGroup>
            <Button variant="ghost" size="icon" className="toolbar-button" aria-label="Zoom in" disabled={!camera.ready || camera.zoom >= camera.maxZoom} onClick={() => mapRef.current?.zoomBy(1)}><PlusIcon size={19} /></Button>
            <Button variant="ghost" size="icon" className="toolbar-button" aria-label="Zoom out" disabled={!camera.ready || camera.zoom <= camera.minZoom + 0.001} onClick={() => mapRef.current?.zoomBy(-1)}><MinusIcon size={19} /></Button>
            <Separator orientation="vertical" className="toolbar-separator" />
            <CurrentLocationButton onSelect={selectDestination} className="toolbar-button" />
            <Button variant="ghost" size="icon" className="toolbar-button" aria-label="Reset view" disabled={!camera.ready} onClick={() => { mapRef.current?.resetView(); setDestination(null) }}><CrosshairIcon size={19} /></Button>
          </ButtonGroup></div></div>
        </main>
      </SidebarProvider>
    </div>
  </TooltipProvider></MantineProvider>
}

export default App
