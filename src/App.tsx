import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react'
import { MantineProvider } from '@mantine/core'
import {
  ArrowsClockwiseIcon,
  BookmarkSimpleIcon,
  ChartBarIcon,
  CameraIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CornersInIcon,
  CornersOutIcon,
  CrosshairIcon,
  InfoIcon,
  MinusIcon,
  MoonIcon,
  PlusIcon,
  PolygonIcon,
  RulerIcon,
  SunIcon,
} from '@phosphor-icons/react'
import {
  isAreaUnit,
  isDistanceUnit,
  measurementUnits,
  type AreaUnit,
  type DistanceUnit,
  type MeasurementMode,
  type MeasurementUnit,
} from '@/lib/measurement-units'
import { MeasurementPanel } from '@/components/MeasurementPanel'
import { AreaAnalytics } from '@/components/AreaAnalytics'
import { AnalysisPanel } from '@/components/AnalysisPanel'
import { analysisReducer, initialAnalysisState } from '@/lib/analysis-state'
import {
  focusRange,
  rangePreset,
  MAX_ANALYSIS_DAYS,
  type AnalysisRange,
} from '@/lib/analysis-activity'
import {
  createInvestigation,
  createGlobalInvestigation,
  investigationKey,
  type InvestigationScope,
  type FrozenSelection,
} from '@/lib/investigation'
import { areaBounds, type AreaGeometry } from '@/lib/analysis-area'
import { useAnalysisCountrySelection } from '@/hooks/use-analysis-country-selection'
import { useAnalysisFires } from '@/hooks/use-analysis-fires'
import type { FireFeature } from '@/lib/fire-severity'
import { CapturePanel } from '@/components/CapturePanel'
import { CaptureSelection } from '@/components/CaptureSelection'
import { LocationNameDialog } from '@/components/LocationNameDialog'
import { MapCredits } from '@/components/MapCredits'
import { resolveLocationCountry } from '@/lib/country-lookup'
import { readShareHash, writeShareHash, type SharedCoordinates } from '@/lib/share-hash'
import {
  DEFAULT_MAP_BACKGROUND,
  DEFAULT_REFERENCE_LAYERS,
  isMapBackground,
  type MapBackground,
  type MapReferenceLayers,
} from '@/map/basemaps'
import type { CaptureRegion, CaptureSettings } from '@/lib/map-capture'
import { CurrentLocationButton, DestinationSearch } from '@/components/DestinationSearch'
import { SavedLocations } from '@/components/SavedLocations'
import type { LocationAppearance } from '@/lib/location-appearance'
import {
  loadSavedLocations,
  persistSavedLocations,
  locationKey,
  type LocationTarget,
} from '@/lib/locations'
import type { MeasurementState } from '@/map/measurement-controller'
import {
  DEFAULT_MEASUREMENT_COLORS,
  isMeasurementColor,
  type MeasurementColor,
  type MeasurementColors,
} from '@/map/measurement-colors'
import type { EarthMapHandle, MapCameraState, GlobalStartupState } from '@/components/EarthMap'
import { GLOBAL_STARTUP_TIMEOUT_MS, mergeGlobalStartupState } from '@/lib/global-startup'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { ButtonGroup } from '@/components/ui/button-group'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Separator } from '@/components/ui/separator'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import './App.css'
import './components/sidebar.css'

const EarthMap = lazy(() =>
  import('@/components/EarthMap').then((module) => ({ default: module.EarthMap })),
)

const LAYER_STORAGE_KEY = 'ethereal-map-layers-v1'
function layerPreference(name: string) {
  try {
    return JSON.parse(localStorage.getItem(LAYER_STORAGE_KEY) ?? '{}')?.[name] !== false
  } catch {
    return true
  }
}
function loadReferenceLayers(): MapReferenceLayers {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYER_STORAGE_KEY) ?? '{}')
    return {
      ...DEFAULT_REFERENCE_LAYERS,
      ...Object.fromEntries(
        Object.keys(DEFAULT_REFERENCE_LAYERS)
          .filter((key) => typeof saved[key] === 'boolean')
          .map((key) => [key, saved[key]]),
      ),
      showRoads: (saved.showRoads ?? saved.infrastructure) !== false,
      showSettlements: (saved.showSettlements ?? saved.infrastructure) !== false,
      showBorders: saved.showBorders !== false,
      showLabels: saved.showLabels !== false,
      showTerrain: (saved.showTerrain ?? saved.terrain) !== false,
    }
  } catch {
    return { ...DEFAULT_REFERENCE_LAYERS }
  }
}
function loadMeasurementColors(): MeasurementColors {
  try {
    const saved = JSON.parse(localStorage.getItem('ethereal-measurement-colors-v1') ?? '{}')
    return {
      ruler: isMeasurementColor(saved.ruler) ? saved.ruler : DEFAULT_MEASUREMENT_COLORS.ruler,
      area: isMeasurementColor(saved.area) ? saved.area : DEFAULT_MEASUREMENT_COLORS.area,
    }
  } catch {
    return { ...DEFAULT_MEASUREMENT_COLORS }
  }
}
const navigation = [
  { name: 'Saved locations', icon: BookmarkSimpleIcon },
  { name: 'Burning Activity Calendar', icon: PolygonIcon },
  { name: 'Area Analytics', icon: ChartBarIcon },
]

const mantineTheme = {
  fontFamily: '"Fira Sans", sans-serif',
  fontFamilyMonospace: '"Fira Sans", sans-serif',
}

function ExplorerSidebar({
  activeNav,
  setActiveNav,
  savedLocations,
  onLocationSelect,
  onLocationRemove,
  onLocationEdit,
}: {
  activeNav: string
  setActiveNav: (name: string) => void
  savedLocations: LocationTarget[]
  onLocationSelect: (location: LocationTarget) => void
  onLocationRemove: (locations: LocationTarget[]) => void
  onLocationEdit: (location: LocationTarget) => void
}) {
  const { open, setOpen, isMobile, openMobile, setOpenMobile } = useSidebar()
  const expanded = isMobile ? openMobile : open
  useEffect(() => {
    let active = true
    const measure = () => {
      if (!active) return
      const context = document.createElement('canvas').getContext('2d')
      if (!context) return
      const button = document.querySelector('#explorer-sidebar [data-slot="sidebar-menu-button"]')
      context.font = button ? getComputedStyle(button).font : '500 14px "Fira Sans", sans-serif'
      const width =
        Math.ceil(
          Math.max(
            ...[...navigation.map((item) => item.name), 'Instructions'].map(
              (name) => context.measureText(name).width,
            ),
          ),
        ) + 90
      document.documentElement.style.setProperty(
        '--explorer-sidebar-width',
        `${Math.max(280, width)}px`,
      )
    }
    measure()
    void document.fonts.ready.then(measure)
    return () => {
      active = false
    }
  }, [])
  const selectNav = (name: string) => {
    setActiveNav(name)
    if (isMobile && (name === 'Area Analytics' || name === 'Burning Activity Calendar'))
      setOpenMobile(false)
    else {
      if (isMobile) setOpenMobile(true)
      else setOpen(true)
    }
  }

  return (
    <Sidebar id="explorer-sidebar" collapsible="icon" aria-label="Explorer navigation">
      <SidebarHeader>
        <span className="sidebar-title">SHARP</span>
        <SidebarTrigger className="sidebar-collapse-trigger" />
        <Separator className="rail-separator" />
      </SidebarHeader>
      <SidebarContent>
        <SidebarMenu>
          {navigation.map(({ name, icon: Icon }) => (
            <SidebarMenuItem key={name}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <SidebarMenuButton
                    className="rail-button"
                    isActive={activeNav === name}
                    aria-label={name}
                    aria-current={activeNav === name ? 'page' : undefined}
                    onClick={() => selectNav(name)}
                  >
                    <Icon size={20} weight="regular" />
                    <span className="sidebar-item-label">{name}</span>
                  </SidebarMenuButton>
                </TooltipTrigger>
                {!expanded && <TooltipContent side="right">{name}</TooltipContent>}
              </Tooltip>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
        {expanded && activeNav === 'Saved locations' && (
          <SavedLocations
            locations={savedLocations}
            onSelect={(location) => {
              onLocationSelect(location)
              if (isMobile) setOpenMobile(false)
            }}
            onRemove={onLocationRemove}
            onEdit={(location) => {
              onLocationEdit(location)
              if (isMobile) setOpenMobile(false)
            }}
          />
        )}
        {expanded && activeNav === 'Instructions' && (
          <section className="sidebar-help" aria-label="Instructions" tabIndex={0}>
            <span className="sidebar-help-kicker">EXPLORER GUIDE</span>
            <h2>Explore Earth</h2>
            <p>
              Left-drag to explore Earth, scroll or pinch to zoom, and switch between Globe and Map.
              Open Map &amp; layers at the upper-right to change map appearance. Right-click to save
              a location or capture a screenshot.
            </p>
            <p>
              The address bar shares only the map center, as latitude and longitude. Copy its URL to
              share those coordinates. Zoom, projection, date, layers, theme, pins and measurements
              are not included in the link.
            </p>
            <p>
              Choose Distance or Area, pick a line color, then click to place points and move the
              pointer to preview. Finish or right-click to keep a valid measurement and start
              another without replacing it. Finished measurements keep their own colors and remain
              until deleted. Right-click near a finished line or area to rename, recolor or delete
              it; its name appears with its value. While drawing, click the starting point to close
              a shape. Each finished distance segment can be edited independently. Close Measure
              tools or choose Orbit mode to drag points. While the drawing tool is open, clicks snap
              to existing endpoints without moving them. An unfinished shape with too few points is
              cleared.
            </p>
            <section
              className="instructions-layer-guide"
              aria-labelledby="instructions-layers-heading"
            >
              <h3 id="instructions-layers-heading">Current map layers</h3>
              <p>
                Choose the base map and optional layers in Map &amp; layers. Detail appears as you
                zoom in. Satellite hotspots use reported fire radiative power in MW.
              </p>
              <h4>Base maps</h4>
              <dl>
                <dt>Blue Marble</dt>
                <dd>NASA&apos;s static Earth imagery for a global view.</dd>
                <dt>Topographic</dt>
                <dd>Land cover, relief, water, roads and place names.</dd>
                <dt>Dark Gray and Light Gray</dt>
                <dd>Low-contrast cartographic styles for viewing geographic detail.</dd>
                <dt>Firefly</dt>
                <dd>A darker view using NASA imagery with restrained map detail.</dd>
              </dl>
              <h4>Reference layers</h4>
              <dl>
                <dt>Coastlines and country borders</dt>
                <dd>Shorelines and international boundaries; disputed borders use dashed lines.</dd>
                <dt>Geographic labels and major cities</dt>
                <dd>
                  Names for countries, continents and water bodies, plus selected city markers.
                </dd>
                <dt>Roads and settlements</dt>
                <dd>
                  Routes, smaller towns and buildings appear progressively at closer zoom levels.
                </dd>
                <dt>Terrain</dt>
                <dd>Shaded relief and land-cover detail in closer map views.</dd>
                <dt>Latitude / longitude grid</dt>
                <dd>
                  Locally generated degree lines and labels that follow Earth in Globe and Map
                  views; no external data source.
                </dd>
              </dl>
              <h4>Context overlays</h4>
              <dl>
                <dt>Protected areas</dt>
                <dd>
                  UNEP-WCMC and IUCN protected-area boundaries and points from the live WDPCA
                  service. The verified release is October 2026; this is not a November 2025
                  snapshot.
                </dd>
                <dt>European protected areas</dt>
                <dd>
                  Natura 2000 site coverage from the European Environment Agency; Europe only.
                </dd>
                <dt>Human built-up extent</dt>
                <dd>Settlement extent mapped from Landsat imagery for 2010.</dd>
                <dt>Known volcanoes</dt>
                <dd>Smithsonian Holocene volcano locations, not an active-eruption feed.</dd>
                <dt>Landsat 8 and 9 scene footprints</dt>
                <dd>
                  Archived HLS scene outlines for the selected UTC date and visible region; zoom in
                  to load them.
                </dd>
              </dl>
              <h4>Space background</h4>
              <p>
                The star map is a background in Globe mode. It is separate from the geographic
                layers on Earth.
              </p>
            </section>
            <MapCredits />
          </section>
        )}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <Tooltip>
              <TooltipTrigger asChild>
                <SidebarMenuButton
                  className="rail-button"
                  isActive={activeNav === 'Instructions'}
                  aria-label="Instructions"
                  aria-current={activeNav === 'Instructions' ? 'page' : undefined}
                  onClick={() => selectNav('Instructions')}
                >
                  <InfoIcon size={20} weight="regular" />
                  <span className="sidebar-item-label">Instructions</span>
                </SidebarMenuButton>
              </TooltipTrigger>
              {!expanded && <TooltipContent side="right">Instructions</TooltipContent>}
            </Tooltip>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}

type ToolButtonProps = {
  label: string
  icon: typeof PlusIcon
  onClick: () => void
  active?: boolean
  disabled?: boolean
  panel?: string
  buttonRef?: RefObject<HTMLButtonElement | null>
}

function ToolButton({
  label,
  icon: Icon,
  onClick,
  active,
  disabled,
  panel,
  buttonRef,
}: ToolButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          ref={buttonRef}
          type="button"
          variant="ghost"
          size="icon"
          className="toolbar-button"
          aria-label={label}
          aria-pressed={active}
          aria-expanded={panel ? Boolean(active) : undefined}
          aria-controls={panel && active ? panel : undefined}
          onClick={onClick}
          disabled={disabled}
          data-active={active || undefined}
        >
          <Icon size={19} weight="regular" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function App() {
  const [initialCoordinates] = useState(() => readShareHash(window.location.hash))
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      return localStorage.getItem('wildfire-theme') === 'dark' ? 'dark' : 'light'
    } catch {
      return 'light'
    }
  })
  const [activeNav, setActiveNav] = useState('Saved locations')
  const [analysis, dispatchAnalysis] = useReducer(analysisReducer, initialAnalysisState)
  const [analysisRange, setAnalysisRange] = useState<AnalysisRange>(() => rangePreset('24h'))
  const [analysisFocusedDay, setAnalysisFocusedDay] = useState<string | null>(null)
  const [activityGeneration, setActivityGeneration] = useState(0)
  const analysisOpen = activeNav === 'Burning Activity Calendar'
  const [mapFilters, setMapFilters] = useState<InvestigationScope['filters']>({})
  const [mapSelection, setMapSelection] = useState<{
    selection: FrozenSelection
    features: FireFeature[]
  } | null>(null)
  const [highlightScope, setHighlightScope] = useState<InvestigationScope | null>(null)
  const compatibleMapHighlight =
    highlightScope &&
    highlightScope.area.id === analysis.confirmed?.id &&
    JSON.stringify(highlightScope.range) === JSON.stringify(analysisRange)
      ? highlightScope
      : null
  const mapFocusedDay = compatibleMapHighlight?.focusedDay ?? analysisFocusedDay
  const fires = useAnalysisFires(analysis.confirmed, analysisRange, mapFocusedDay, {
    filters: compatibleMapHighlight?.filters ?? mapFilters,
    selection: compatibleMapHighlight ? compatibleMapHighlight.selection : mapSelection?.selection,
  })
  const [analyticsScope, setAnalyticsScope] = useState<InvestigationScope | null>(null)
  const [globalMapScope, setGlobalMapScope] = useState<InvestigationScope | null>(null)
  const [latestGlobalScope, setLatestGlobalScope] = useState<InvestigationScope | null>(null)
  const [startup, setStartup] = useState<GlobalStartupState>({
    ready: false,
    phase: 'fetching',
    error: '',
  })
  const [entered, setEntered] = useState(false)
  const [startupAttempt, setStartupAttempt] = useState(0)
  const [startupStartedAt] = useState(() => Date.now())
  useEffect(() => {
    if (!startup.ready) return
    const timer = setTimeout(
      () => setEntered(true),
      Math.max(0, 450 - (Date.now() - startupStartedAt)),
    )
    return () => clearTimeout(timer)
  }, [startup.ready, startupStartedAt])
  useEffect(() => {
    if (entered || startup.ready) return
    const timer = setTimeout(
      () =>
        setStartup((current) =>
          current.ready
            ? current
            : {
                ...current,
                error:
                  'Loading the last 24 hours is taking longer than expected. Check your connection and retry.',
              },
        ),
      GLOBAL_STARTUP_TIMEOUT_MS,
    )
    return () => clearTimeout(timer)
  }, [entered, startup.ready, startupAttempt])
  const [analyticsMobile, setAnalyticsMobile] = useState(false)
  const [analyticsTab, setAnalyticsTab] = useState<'map' | 'analytics'>('analytics')
  const [mapShare, setMapShare] = useState(45)
  const [analyticsSnapshot, setAnalyticsSnapshot] = useState<
    { url: string; scopeKey: string } | undefined
  >()
  const snapshotRequest = useRef(0)
  const dividerDrag = useRef(false)
  const mapSelectionCurrent =
    !!mapSelection &&
    (mapSelection.selection.sourceGeneration
      ? mapSelection.selection.sourceGeneration === fires.meta?.sourceGeneration
      : mapSelection.features === fires.features)
  function openAnalytics(selection?: FrozenSelection, cellGeometry?: AreaGeometry) {
    let transferred: InvestigationScope | null
    if (selection?.global)
      transferred = createGlobalInvestigation(selection.global, selection.filters, {
        sourceGeneration: selection.global.snapshotId,
      })
    else if (cellGeometry || analysis.confirmed) {
      const area = cellGeometry
        ? {
            id: `cell:${JSON.stringify(cellGeometry.coordinates)}`,
            name: 'Selected diagnostic cell',
            type: 'polygon' as const,
            geometry: cellGeometry,
            bounds: areaBounds(cellGeometry),
          }
        : analysis.confirmed!
      transferred = createInvestigation(
        area,
        analysisRange,
        fires.meta,
        analysisFocusedDay,
        { ...mapFilters, ...selection?.filters },
        selection ?? mapSelection?.selection,
      )
    } else transferred = globalMapScope ?? latestGlobalScope
    setAnalyticsScope(transferred ? structuredClone(transferred) : null)
    setAnalyticsSnapshot(undefined)
    
    snapshotRequest.current++
    setAnalyticsTab('analytics')
    setActiveNav('Area Analytics')
  }
  function applyAnalyticsScope(scope: InvestigationScope) {
    setHighlightScope(null)
    if (scope.selection?.global) {
      setGlobalMapScope(structuredClone(scope))
      dispatchAnalysis({ type: 'apply-investigation', area: null })
    } else {
      setGlobalMapScope(null)
      dispatchAnalysis({ type: 'apply-investigation', area: scope.area })
      setAnalysisRange(scope.range)
      setAnalysisFocusedDay(scope.focusedDay)
      setMapFilters(scope.filters)
      setMapSelection(
        scope.selection ? { selection: scope.selection, features: fires.features } : null,
      )
    }
    setAnalyticsTab('map')
  }
  function refreshAnalyticsSelection() {
    if (analyticsScope?.selection?.global) {
      const refreshed = mapRef.current?.refreshGlobalObservations()
      setGlobalMapScope(null)
      setHighlightScope(null)
      setAnalyticsSnapshot(undefined)
      const requestId = ++snapshotRequest.current
      void refreshed
        ?.then((scope) => {
          setLatestGlobalScope(scope)
          if (snapshotRequest.current === requestId) setAnalyticsScope(scope)
        })
        .catch(() => undefined)
    }
    setActiveNav('Saved locations')
  }
  async function captureAnalyticsScope(scope: InvestigationScope) {
    const requestId = ++snapshotRequest.current
    applyAnalyticsScope(scope)
    const deadline = Date.now() + 15000
    let capture
    while (Date.now() < deadline && requestId === snapshotRequest.current) {
      await new Promise((resolve) => setTimeout(resolve, 150))
      capture = await mapRef.current?.captureInvestigation(scope)
      if (capture) break
    }
    if (!capture || requestId !== snapshotRequest.current)
      throw new Error(
        'This investigation is not ready on the map. Wait for observations, then capture again.',
      )
    const url = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = reject
      reader.readAsDataURL(capture.image)
    })
    if (requestId !== snapshotRequest.current) return
    setAnalyticsSnapshot({ url, scopeKey: investigationKey(scope) })
    setAnalyticsTab('analytics')
  }
  const fireQuery = useMemo(() => {
    const selectedQuery = compatibleMapHighlight
      ? compatibleMapHighlight.selection?.query
      : mapSelectionCurrent
        ? mapSelection?.selection.query
        : undefined
    return (
      selectedQuery ??
      (analysis.confirmed
        ? createInvestigation(
            analysis.confirmed,
            (Date.parse(analysisRange.end) - Date.parse(analysisRange.start)) / 86_400_000 >=
              MAX_ANALYSIS_DAYS && mapFocusedDay
              ? focusRange(analysisRange, mapFocusedDay)
              : analysisRange,
          ).query
        : null)
    )
  }, [
    analysis.confirmed,
    analysisRange,
    mapFocusedDay,
    compatibleMapHighlight,
    mapSelectionCurrent,
    mapSelection,
  ])
  const countrySelection = useAnalysisCountrySelection(analysisOpen, analysis, dispatchAnalysis)
  const diagnosticQuery = useMemo(
    () =>
      analysis.confirmed ? createInvestigation(analysis.confirmed, analysisRange).query : null,
    [analysis.confirmed, analysisRange],
  )
  const [camera, setCamera] = useState<MapCameraState>({
    ready: false,
    zoom: 1,
    minZoom: -1,
    maxZoom: 18,
    longitude: 18,
    latitude: 12,
    view: 'globe',
  })
  const [sharedNavigation, setSharedNavigation] = useState<SharedCoordinates | null>(null)
  const [shareRevision, setShareRevision] = useState(0)
  const restoringHashRef = useRef(false)
  const restoreTimerRef = useRef<number | undefined>(undefined)
  const [referenceLayers, setReferenceLayers] = useState<MapReferenceLayers>(loadReferenceLayers)
  const [showSpace, setShowSpace] = useState(() => layerPreference('space'))
  const [background, setBackground] = useState<MapBackground>(() => {
    try {
      const stored = localStorage.getItem('ethereal-map-background-v1')
      return isMapBackground(stored) ? stored : DEFAULT_MAP_BACKGROUND
    } catch {
      return DEFAULT_MAP_BACKGROUND
    }
  })
  const [measurement, setMeasurement] = useState<MeasurementState | null>(null)
  const [measurementColors, setMeasurementColors] =
    useState<MeasurementColors>(loadMeasurementColors)
  const [destination, setDestination] = useState<LocationTarget | null>(null)
  const [destinationRequest, setDestinationRequest] = useState(0)
  const [savedNavigation, setSavedNavigation] = useState(false)
  const [pendingSave, setPendingSave] = useState<LocationTarget | null>(null)
  const [editingLocation, setEditingLocation] = useState<LocationTarget | null>(null)
  const [savedLocations, setSavedLocations] = useState<LocationTarget[]>(loadSavedLocations)
  const [storageNotice, setStorageNotice] = useState('')
  const [mode, setMode] = useState<'orbit' | MeasurementMode>('orbit')
  const [lastMeasurementMode, setLastMeasurementMode] = useState<MeasurementMode>('ruler')
  const [fullscreen, setFullscreen] = useState(false)
  const [toolbarMinimized, setToolbarMinimized] = useState(false)
  const [captureOpen, setCaptureOpen] = useState(false)
  const [captureRegion, setCaptureRegion] = useState<CaptureRegion | null>(null)
  const [selectingCapture, setSelectingCapture] = useState(false)
  const [distanceUnit, setDistanceUnit] = useState<DistanceUnit>(() => {
    try {
      return localStorage.getItem('wildfire-distance-unit') === 'mi' ? 'mi' : 'km'
    } catch {
      return 'km'
    }
  })
  const [areaUnit, setAreaUnit] = useState<AreaUnit>(() => {
    try {
      const saved = localStorage.getItem('wildfire-area-unit')
      return isAreaUnit(saved) ? saved : 'ha'
    } catch {
      return 'ha'
    }
  })
  const mapRef = useRef<EarthMapHandle>(null)
  const stageRef = useRef<HTMLElement>(null)
  const measurementsTriggerRef = useRef<HTMLButtonElement>(null)
  const captureTriggerRef = useRef<HTMLButtonElement>(null)
  const toolbarToggleRef = useRef<HTMLButtonElement>(null)
  const measurementUnit = mode === 'area' ? areaUnit : distanceUnit
  const themeAction = theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'
  const areaAnalyticsOpen = activeNav === 'Area Analytics'
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const observer = new ResizeObserver(([entry]) =>
      setAnalyticsMobile(entry.contentRect.width < 820),
    )
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('wildfire-theme', theme)
    } catch {}
  }, [theme])

  useEffect(() => {
    try {
      localStorage.setItem('wildfire-distance-unit', distanceUnit)
    } catch {}
  }, [distanceUnit])

  useEffect(() => {
    try {
      localStorage.setItem('wildfire-area-unit', areaUnit)
    } catch {}
  }, [areaUnit])

  useEffect(() => {
    try {
      localStorage.setItem('ethereal-measurement-colors-v1', JSON.stringify(measurementColors))
    } catch {}
  }, [measurementColors])

  useEffect(() => {
    const onFullscreenChange = () => setFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(
        LAYER_STORAGE_KEY,
        JSON.stringify({ ...referenceLayers, space: showSpace }),
      )
    } catch {}
  }, [referenceLayers, showSpace])

  useEffect(() => {
    try {
      localStorage.setItem('ethereal-map-background-v1', background)
    } catch {}
  }, [background])

  useEffect(() => {
    const onHashChange = () => {
      const shared = readShareHash(window.location.hash)
      if (!shared) return
      window.clearTimeout(restoreTimerRef.current)
      restoringHashRef.current = true
      setSharedNavigation(shared)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => {
      window.removeEventListener('hashchange', onHashChange)
      window.clearTimeout(restoreTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!camera.ready || restoringHashRef.current) return
    writeShareHash({ longitude: camera.longitude, latitude: camera.latitude })
  }, [camera.ready, camera.longitude, camera.latitude, shareRevision])

  useEffect(() => {
    if (!destination || destination.country) return
    let active = true
    void resolveLocationCountry(destination).then((enriched) => {
      if (active && enriched.country)
        setDestination((current) =>
          current && locationKey(current) === locationKey(enriched)
            ? { ...current, country: enriched.country }
            : current,
        )
    })
    return () => {
      active = false
    }
  }, [destination])

  useEffect(() => {
    if (!savedLocations.some((location) => !location.country)) return
    let active = true
    void Promise.all(savedLocations.map(resolveLocationCountry)).then((enriched) => {
      if (
        !active ||
        enriched.every((location, index) => location.country === savedLocations[index].country)
      )
        return
      setSavedLocations(enriched)
      persistSavedLocations(enriched)
    })
    return () => {
      active = false
    }
  }, [savedLocations])

  function selectDestination(location: LocationTarget, fromSaved = false) {
    chooseMode('orbit')
    setSavedNavigation(fromSaved)
    setDestination({ ...location, coordinates: [...location.coordinates] })
    setDestinationRequest((current) => current + 1)
  }

  function saveLocation(location: LocationTarget) {
    if (
      savedLocations.length >= 100 &&
      !savedLocations.some((saved) => locationKey(saved) === locationKey(location))
    ) {
      setStorageNotice(
        'Saved locations are full (100). Remove a saved location before adding another.',
      )
      return false
    }
    const next = [
      location,
      ...savedLocations.filter((saved) => locationKey(saved) !== locationKey(location)),
    ].slice(0, 100)
    const persisted = persistSavedLocations(next)
    setSavedLocations(next)
    setStorageNotice(
      persisted
        ? ''
        : 'Saved for this session. Browser storage is unavailable, so this location will not survive a reload.',
    )
    return true
  }

  function renameLocation(location: LocationTarget, name: string, appearance: LocationAppearance) {
    const nextName = name.trim()
    if (!nextName) return
    const key = locationKey(location)
    const next = savedLocations.map((saved) =>
      locationKey(saved) === key ? { ...saved, name: nextName, ...appearance } : saved,
    )
    const persisted = persistSavedLocations(next)
    setSavedLocations(next)
    setDestination((current) =>
      current && locationKey(current) === key
        ? { ...current, name: nextName, ...appearance }
        : current,
    )
    setStorageNotice(persisted ? '' : 'Updated for this session. Browser storage is unavailable.')
  }

  function saveNamedLocation(name: string, appearance: LocationAppearance) {
    if (!pendingSave) return
    const named = { ...pendingSave, name, ...appearance }
    if (!saveLocation(named)) return
    setDestination(named)
    setPendingSave(null)
  }

  function removeLocations(locations: LocationTarget[]) {
    const removedKeys = new Set(locations.map(locationKey))
    if (!removedKeys.size) return
    const next = savedLocations.filter((saved) => !removedKeys.has(locationKey(saved)))
    const persisted = persistSavedLocations(next)
    setSavedLocations(next)
    setDestination((current) => (current && removedKeys.has(locationKey(current)) ? null : current))
    setEditingLocation((current) =>
      current && removedKeys.has(locationKey(current)) ? null : current,
    )
    setStorageNotice(persisted ? '' : 'Updated for this session. Browser storage is unavailable.')
  }

  function chooseMode(nextMode: 'orbit' | MeasurementMode) {
    if (nextMode !== 'orbit') countrySelection.cancel()
    if (nextMode !== 'orbit') setLastMeasurementMode(nextMode)
    setMode(nextMode)
  }

  function changeReferenceLayer(key: keyof MapReferenceLayers, value: boolean) {
    setReferenceLayers((current) => ({ ...current, [key]: value }))
  }

  function closeMeasurements() {
    chooseMode('orbit')
    const trigger = toolbarMinimized ? toolbarToggleRef.current : measurementsTriggerRef.current
    trigger?.focus({ preventScroll: true })
  }

  function toggleMeasurements() {
    if (mode === 'orbit') chooseMode(lastMeasurementMode)
    else closeMeasurements()
  }

  function closeCapture() {
    setCaptureOpen(false)
    setSelectingCapture(false)
    const trigger = toolbarMinimized ? toolbarToggleRef.current : captureTriggerRef.current
    trigger?.focus({ preventScroll: true })
  }

  function toggleCapture() {
    if (captureOpen) closeCapture()
    else setCaptureOpen(true)
  }

  function beginCaptureSelection() {
    countrySelection.cancel()
    chooseMode('orbit')
    setCaptureOpen(true)
    setSelectingCapture(true)
  }

  async function createCapturePreview(settings: CaptureSettings) {
    if (!mapRef.current) throw new Error('The map is not ready yet.')
    return mapRef.current.createCapturePreview(settings, captureRegion ?? undefined)
  }

  function selectMeasurementUnit(unit: MeasurementUnit) {
    if (isDistanceUnit(unit)) setDistanceUnit(unit)
    else setAreaUnit(unit)
    chooseMode(measurementUnits[unit].mode)
  }

  function selectMeasurementColor(color: MeasurementColor) {
    if (mode === 'orbit') return
    setMeasurementColors((current) => ({ ...current, [mode]: color }))
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await document.documentElement.requestFullscreen()
    } catch {}
  }

  return (
    <MantineProvider theme={mantineTheme} forceColorScheme={theme}>
      <TooltipProvider>
        {!entered && (
          <div
            className="startup-loading"
            data-slot="startup-loading"
            role={startup.error ? 'alert' : undefined}
            aria-live="polite"
          >
            <img
              src={`${import.meta.env.BASE_URL}brand/${theme === 'dark' ? 'sharp-logo-white.svg' : 'sharp-logo.svg'}`}
              alt="SHARP"
              width={120}
              height={64}
            />
            {startup.error ? (
              <>
                <p>{startup.error}</p>
                <Button
                  variant="outline"
                  onClick={() => {
                    setStartup({ ready: false, phase: 'fetching', error: '' })
                    setStartupAttempt((value) => value + 1)
                  }}
                >
                  Retry
                </Button>
                <Button variant="ghost" onClick={() => setEntered(true)}>
                  Open map
                </Button>
              </>
            ) : (
              <>
                <Spinner className="startup-spinner" />
                <p>
                  {startup.phase === 'fetching'
                    ? 'Loading hotspots from the last 24 hours…'
                    : 'Preparing the globe…'}
                </p>
              </>
            )}
          </div>
        )}
        <div
          className="app-shell"
          data-slot="app-content"
          data-startup-pending={!entered || undefined}
          inert={!entered}
          aria-hidden={!entered || undefined}
        >
          <header className="app-header">
            <div
              className="header-brand"
              aria-label="Satellite Harmonization and Activity Records Platform"
              title="Satellite Harmonization and Activity Records Platform"
            >
              <span className="brand-symbol" aria-hidden="true">
                <img
                  className="brand-logo"
                  src={`${import.meta.env.BASE_URL}brand/${theme === 'dark' ? 'sharp-logo-white.svg' : 'sharp-logo.svg'}`}
                  alt=""
                  width={76}
                  height={40}
                  draggable={false}
                />
              </span>
              <span className="brand-copy">
                <span className="brand-subtitle">
                  Satellite Harmonization and Activity Records Platform
                </span>
              </span>
            </div>

            <DestinationSearch onSelect={selectDestination} />

            <div className="header-actions">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="theme-toggle"
                    aria-label={themeAction}
                    onClick={() => setTheme((current) => (current === 'light' ? 'dark' : 'light'))}
                  >
                    {theme === 'light' ? (
                      <MoonIcon size={18} weight="regular" />
                    ) : (
                      <SunIcon size={18} weight="regular" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{themeAction}</TooltipContent>
              </Tooltip>
            </div>
          </header>

          <SidebarProvider
            defaultOpen={false}
            className="app-body"
            data-analysis-open={analysisOpen}
            style={
              {
                '--sidebar-width': 'var(--explorer-sidebar-width, 300px)',
                '--sidebar-width-icon': '70px',
              } as CSSProperties
            }
          >
            <ExplorerSidebar
              activeNav={activeNav}
              setActiveNav={(name) => {
                if (name !== 'Burning Activity Calendar') {
                  if (analysis.phase === 'loading') countrySelection.cancel()
                  else countrySelection.stopPicking()
                }
                if (name === 'Area Analytics') {
                  openAnalytics()
                  return
                }
                if (name === 'Burning Activity Calendar') {
                  chooseMode('orbit')
                  setCaptureOpen(false)
                  setSelectingCapture(false)
                }
                setActiveNav(name)
              }}
              savedLocations={savedLocations}
              onLocationSelect={(location) => selectDestination(location, true)}
              onLocationRemove={removeLocations}
              onLocationEdit={setEditingLocation}
            />

            <div className="analysis-layout">
              {analysisOpen && (
                <AnalysisPanel
                  state={analysis}
                  ready={camera.ready}
                  view={camera.view}
                  countries={countrySelection.countries}
                  catalogueLoading={countrySelection.catalogueLoading}
                  catalogueError={countrySelection.catalogueError}
                  picking={countrySelection.picking}
                  canRetryBoundary={Boolean(countrySelection.lastCountryId)}
                  onRetryCatalogue={countrySelection.retryCatalogue}
                  onRetryBoundary={() => {
                    if (countrySelection.lastCountryId)
                      countrySelection.selectCountry(countrySelection.lastCountryId)
                  }}
                  onCountrySelect={countrySelection.selectCountry}
                  onPickingChange={countrySelection.setPicking}
                  onDraw={(tool) => {
                    chooseMode('orbit')
                    setCaptureOpen(false)
                    setSelectingCapture(false)
                    dispatchAnalysis({ type: 'draw', tool })
                  }}
                  onFinish={() => mapRef.current?.finishAnalysisDrawing()}
                  onEdit={() => {
                    countrySelection.stopPicking()
                    chooseMode('orbit')
                    dispatchAnalysis({ type: 'edit' })
                  }}
                  onConfirm={() => {
                    setGlobalMapScope(null)
                    setHighlightScope(null)
                    setMapFilters({})
                    setMapSelection(null)
                    setAnalysisFocusedDay(null)
                    setActivityGeneration((current) => current + 1)
                    countrySelection.setPicking(false)
                    dispatchAnalysis({ type: 'confirm' })
                  }}
                  onFitArea={() => dispatchAnalysis({ type: 'fit' })}
                  onCancel={countrySelection.cancel}
                  onClear={() => {
                    setGlobalMapScope(null)
                    setHighlightScope(null)
                    setMapFilters({})
                    setMapSelection(null)
                    countrySelection.clear()
                  }}
                  onClose={() => {
                    countrySelection.stopPicking()
                    setActiveNav('Saved locations')
                  }}
                  range={analysisRange}
                  generation={activityGeneration}
                  onRangeChange={(next) => {
                    setHighlightScope(null)
                    setMapFilters({})
                    setMapSelection(null)
                    setAnalysisFocusedDay(null)
                    setAnalysisRange(next)
                  }}
                  focusedDay={analysisFocusedDay}
                  onFocusDay={setAnalysisFocusedDay}
                  activity={fires.activity}
                  fireMeta={fires.meta}
                  fireStatus={fires.status}
                  fireCount={fires.count}
                  fireMessage={fires.message}
                  onRetryFires={fires.retry}
                  onOpenAnalytics={() => openAnalytics()}
                />
              )}
              <main
                ref={stageRef}
                className="explorer-stage"
                aria-label={
                  areaAnalyticsOpen ? 'Area Analytics workspace' : 'Global Earth explorer'
                }
                data-capture-selecting={selectingCapture || undefined}
                data-investigation-layout={
                  areaAnalyticsOpen ? (analyticsMobile ? 'mobile' : 'split') : undefined
                }
                data-investigation-tab={analyticsTab}
                style={{ '--map-share': `${mapShare}%` } as CSSProperties}
              >
                {areaAnalyticsOpen && analyticsMobile && (
                  <div
                    role="tablist"
                    aria-label="Investigation views"
                    className="investigation-mobile-tabs"
                  >
                    <Button
                      role="tab"
                      aria-selected={analyticsTab === 'map'}
                      variant="outline"
                      onClick={() => setAnalyticsTab('map')}
                    >
                      Map
                    </Button>
                    <Button
                      role="tab"
                      aria-selected={analyticsTab === 'analytics'}
                      variant="outline"
                      onClick={() => setAnalyticsTab('analytics')}
                    >
                      Analytics
                    </Button>
                  </div>
                )}
                <div
                  className="map-workspace"
                  inert={areaAnalyticsOpen && analyticsMobile && analyticsTab !== 'map'}
                >
                  <Suspense
                    fallback={
                      <div className="map-loading" role="status">
                        Loading map.
                      </div>
                    }
                  >
                    <EarthMap
                      key={startupAttempt}
                      ref={mapRef}
                      onStartupChange={(next) =>
                        setStartup((current) => mergeGlobalStartupState(current, next))
                      }
                      analysis={analysis}
                      analysisOpen={analysisOpen}
                      analysisPicking={countrySelection.picking}
                      onCountryPick={countrySelection.selectCountry}
                      onAnalysisChange={(area, error, vertices) =>
                        dispatchAnalysis({ type: 'drawing', area, error, vertices })
                      }
                      onAnalysisFinish={(area, error) =>
                        dispatchAnalysis({ type: 'finish', area, error })
                      }
                      onAnalysisCancel={countrySelection.cancel}
                      analysisDistanceUnit={distanceUnit}
                      analysisAreaUnit={areaUnit}
                      initialView="globe"
                      initialCoordinates={initialCoordinates}
                      sharedNavigation={sharedNavigation}
                      onSharedNavigationApplied={() => {
                        window.clearTimeout(restoreTimerRef.current)
                        restoreTimerRef.current = window.setTimeout(() => {
                          restoringHashRef.current = false
                          setShareRevision((current) => current + 1)
                        }, 0)
                      }}
                      dataDate={mapFocusedDay ?? analysisRange.end}
                      fires={fires.features}
                      focusedFireDay={mapFocusedDay}
                      fireRange={analysisRange}
                      fireQuery={fireQuery}
                      diagnosticQuery={diagnosticQuery}
                      fireSourceGeneration={fires.meta?.sourceGeneration}
                      fireFilters={mapFilters}
                      selectedObservationIds={
                        compatibleMapHighlight
                          ? compatibleMapHighlight.selection?.observationIds
                          : mapSelection
                            ? mapSelectionCurrent
                              ? mapSelection.selection.observationIds
                              : []
                            : undefined
                      }
                      onOpenAnalytics={openAnalytics}
                      globalInvestigation={globalMapScope}
                      highlightInvestigation={highlightScope}
                      onGlobalInvestigation={setLatestGlobalScope}
                      onResetGlobalInvestigation={() => {
                        setGlobalMapScope(null)
                        setHighlightScope(null)
                      }}
                      referenceLayers={referenceLayers}
                      onReferenceChange={changeReferenceLayer}
                      showSpace={showSpace}
                      onSpaceChange={setShowSpace}
                      background={background}
                      onBackgroundChange={setBackground}
                      measurementMode={mode}
                      measurementUnit={measurementUnit}
                      measurementColors={measurementColors}
                      onMeasurementChange={setMeasurement}
                      onMeasurementStorageError={setStorageNotice}
                      onRequestSaveLocation={setPendingSave}
                      onCaptureRegion={beginCaptureSelection}
                      navigationRequest={destinationRequest}
                      savedNavigation={savedNavigation}
                      destination={destination}
                      savedLocations={savedLocations}
                      onRemoveSavedLocation={(location) => removeLocations([location])}
                      destinationSaved={Boolean(
                        destination &&
                        savedLocations.some(
                          (saved) => locationKey(saved) === locationKey(destination),
                        ),
                      )}
                      onSaveLocation={setPendingSave}
                      onDismissLocation={() => setDestination(null)}
                      onCameraChange={setCamera}
                    />
                  </Suspense>
                  {storageNotice && (
                    <p className="location-storage-notice" role="status">
                      {storageNotice}
                    </p>
                  )}
                  {mode !== 'orbit' && (
                    <MeasurementPanel
                      containerRef={stageRef}
                      mode={mode}
                      unit={measurementUnit}
                      color={measurementColors[mode]}
                      canUndo={measurement?.canUndo ?? false}
                      canClear={measurement?.canClear ?? false}
                      canFinish={measurement?.canFinish ?? false}
                      onUndo={() => mapRef.current?.undoMeasurement()}
                      onClear={() => mapRef.current?.clearMeasurement()}
                      onFinish={() => mapRef.current?.finishMeasurement()}
                      onModeChange={chooseMode}
                      onUnitChange={selectMeasurementUnit}
                      onColorChange={selectMeasurementColor}
                      onClose={closeMeasurements}
                    />
                  )}
                  {captureOpen && (
                    <div inert={selectingCapture}>
                      <CapturePanel
                        containerRef={stageRef}
                        onClose={closeCapture}
                        onPreview={createCapturePreview}
                        region={captureRegion}
                        onSelectRegion={beginCaptureSelection}
                        onClearRegion={() => setCaptureRegion(null)}
                        captureReady={camera.ready && !selectingCapture}
                      />
                    </div>
                  )}
                  {selectingCapture && (
                    <CaptureSelection
                      onSelected={(region) => {
                        setCaptureRegion(region)
                        setSelectingCapture(false)
                      }}
                      onCancel={() => setSelectingCapture(false)}
                    />
                  )}

                  <Collapsible
                    className="globe-tools"
                    open={!toolbarMinimized}
                    onOpenChange={(open) => setToolbarMinimized(!open)}
                    data-minimized={toolbarMinimized || undefined}
                  >
                    <CollapsibleContent
                      forceMount
                      className="toolbar-reveal"
                      inert={toolbarMinimized}
                      aria-hidden={toolbarMinimized || undefined}
                    >
                      <div className="toolbar-motion">
                        <div id="globe-toolbar" className="bottom-toolbar" aria-label="Globe tools">
                          <ButtonGroup>
                            <ToolButton
                              label="Zoom in"
                              icon={PlusIcon}
                              onClick={() => mapRef.current?.zoomBy(1)}
                              disabled={!camera.ready || camera.zoom >= camera.maxZoom}
                            />
                            <ToolButton
                              label="Zoom out"
                              icon={MinusIcon}
                              onClick={() => mapRef.current?.zoomBy(-1)}
                              disabled={!camera.ready || camera.zoom <= camera.minZoom + 0.001}
                            />
                            <Separator orientation="vertical" className="toolbar-separator" />
                            <CurrentLocationButton
                              onSelect={selectDestination}
                              className="toolbar-button"
                            />
                            <ToolButton
                              label="Reset view"
                              icon={CrosshairIcon}
                              onClick={() => {
                                mapRef.current?.resetView()
                                setDestination(null)
                              }}
                              disabled={!camera.ready}
                            />
                            <ToolButton
                              label="Orbit mode"
                              icon={ArrowsClockwiseIcon}
                              active={mode === 'orbit'}
                              onClick={() => chooseMode('orbit')}
                            />
                            <ToolButton
                              label="Measurements"
                              icon={RulerIcon}
                              active={mode !== 'orbit'}
                              panel="measurement-panel"
                              buttonRef={measurementsTriggerRef}
                              onClick={toggleMeasurements}
                            />
                            <ToolButton
                              label="Screenshot"
                              icon={CameraIcon}
                              active={captureOpen}
                              panel="capture-panel"
                              buttonRef={captureTriggerRef}
                              onClick={toggleCapture}
                            />
                            <ToolButton
                              label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                              icon={fullscreen ? CornersInIcon : CornersOutIcon}
                              onClick={() => {
                                void toggleFullscreen()
                              }}
                            />
                          </ButtonGroup>
                        </div>
                      </div>
                    </CollapsibleContent>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <CollapsibleTrigger asChild>
                          <Button
                            ref={toolbarToggleRef}
                            type="button"
                            variant="outline"
                            size="icon-sm"
                            className="toolbar-toggle"
                            aria-label={
                              toolbarMinimized ? 'Show globe tools' : 'Minimize globe tools'
                            }
                          >
                            {toolbarMinimized ? (
                              <CaretRightIcon size={16} />
                            ) : (
                              <CaretLeftIcon size={16} />
                            )}
                          </Button>
                        </CollapsibleTrigger>
                      </TooltipTrigger>
                      <TooltipContent>
                        {toolbarMinimized ? 'Show globe tools' : 'Minimize globe tools'}
                      </TooltipContent>
                    </Tooltip>
                  </Collapsible>
                </div>
                {mapSelection && !areaAnalyticsOpen && (
                  <div className="map-investigation-selection">
                    <span>
                      {mapSelectionCurrent
                        ? `Selected group - ${mapSelection.selection.observationIds?.length ?? 0} observations`
                        : 'Source changed. Select the group again to refresh its membership.'}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setMapSelection(null)
                        setMapFilters({})
                        setHighlightScope(null)
                        setAnalysisFocusedDay(null)
                      }}
                    >
                      Whole area
                    </Button>
                  </div>
                )}
                {areaAnalyticsOpen && (
                  <>
                    {!analyticsMobile && (
                      <div
                        className="investigation-divider"
                        role="separator"
                        aria-label="Resize map and analytics"
                        aria-orientation="vertical"
                        aria-valuemin={30}
                        aria-valuemax={65}
                        aria-valuenow={mapShare}
                        tabIndex={0}
                        onKeyDown={(event) => {
                          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                            event.preventDefault()
                            setMapShare((value) =>
                              Math.max(
                                30,
                                Math.min(65, value + (event.key === 'ArrowLeft' ? 2 : -2)),
                              ),
                            )
                          }
                        }}
                        onPointerDown={(event) => {
                          dividerDrag.current = true
                          event.currentTarget.setPointerCapture(event.pointerId)
                        }}
                        onPointerMove={(event) => {
                          if (!dividerDrag.current || !stageRef.current) return
                          const box = stageRef.current.getBoundingClientRect()
                          setMapShare(
                            Math.max(
                              (320 / box.width) * 100,
                              Math.min(
                                100 - (408 / box.width) * 100,
                                (1 - (event.clientX - box.left) / box.width) * 100,
                              ),
                            ),
                          )
                        }}
                        onPointerUp={() => {
                          dividerDrag.current = false
                        }}
                        onLostPointerCapture={() => {
                          dividerDrag.current = false
                        }}
                      />
                    )}
                    <div
                      className="analytics-workspace"
                      hidden={analyticsMobile && analyticsTab !== 'analytics'}
                    >
                      <AreaAnalytics
                        analysisArea={analysis.confirmed}
                        scope={analyticsScope}
                        onApply={applyAnalyticsScope}
                        onHighlight={setHighlightScope}
                        snapshot={analyticsSnapshot}
                        onCapture={captureAnalyticsScope}
                        onChooseArea={() => setActiveNav('Burning Activity Calendar')}
                        onRefreshSelection={refreshAnalyticsSelection}
                        onScopeChange={setAnalyticsScope}
                        onClose={() => setActiveNav('Saved locations')}
                      />
                    </div>
                  </>
                )}
              </main>
            </div>
          </SidebarProvider>
          <LocationNameDialog
            location={pendingSave}
            title="Save location"
            onSubmit={saveNamedLocation}
            onClose={() => setPendingSave(null)}
          />
          <LocationNameDialog
            location={editingLocation}
            title="Edit location"
            onSubmit={(name, appearance) => {
              if (editingLocation) renameLocation(editingLocation, name, appearance)
              setEditingLocation(null)
            }}
            onClose={() => setEditingLocation(null)}
          />
        </div>
      </TooltipProvider>
    </MantineProvider>
  )
}

export default App
