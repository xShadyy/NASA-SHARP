import { useEffect, useId, useRef, useState } from 'react'
import {
  CrosshairIcon,
  MagnifyingGlassIcon,
  MapPinIcon,
  NavigationArrowIcon,
  SpinnerGapIcon,
  XIcon,
} from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Command, CommandItem, CommandList } from '@/components/ui/command'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { geocodeDestination } from '@/lib/geocoding'
import {
  formatCoordinates,
  loadSearchPlaces,
  matchLocalPlaces,
  parseCoordinateTarget,
  type LocationTarget,
  type SearchPlace,
} from '@/lib/locations'
import './DestinationSearch.css'

type DestinationSearchProps = {
  onSelect: (location: LocationTarget) => void
}

export function DestinationSearch({ onSelect }: DestinationSearchProps) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [places, setPlaces] = useState<SearchPlace[]>([])
  const [remoteResults, setRemoteResults] = useState<LocationTarget[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const requestRef = useRef<AbortController | null>(null)
  const blurTimer = useRef<number | undefined>(undefined)
  const listId = useId()
  const coordinateTarget = parseCoordinateTarget(query)
  const localResults = matchLocalPlaces(places, query)
  const results = coordinateTarget ? [coordinateTarget] : (remoteResults ?? localResults)
  const visible = open && Boolean(query.trim())

  useEffect(() => {
    let disposed = false
    loadSearchPlaces()
      .then((data) => {
        if (!disposed) setPlaces(data)
      })
      .catch(() => {})
    return () => {
      disposed = true
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !event.repeat &&
        !event.isComposing &&
        document.activeElement === inputRef.current
      ) {
        event.preventDefault()
        requestRef.current?.abort()
        setLoading(false)
        setOpen(false)
        inputRef.current?.blur()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.clearTimeout(blurTimer.current)
      requestRef.current?.abort()
    }
  }, [])

  function updateQuery(value: string) {
    requestRef.current?.abort()
    setQuery(value)
    setRemoteResults(null)
    setError('')
    setLoading(false)
    setActiveIndex(0)
    setOpen(true)
  }

  function selectLocation(location: LocationTarget) {
    requestRef.current?.abort()
    setLoading(false)
    setQuery(location.name)
    setOpen(false)
    inputRef.current?.blur()
    onSelect(location)
  }

  async function searchOnline() {
    if (!query.trim() || loading) return
    if (/^\(?\s*[+-]?\d/.test(query) && /[,;]/.test(query) && !parseCoordinateTarget(query)) {
      setError(
        'Enter latitude from −90 to 90, then longitude from −180 to 180, separated by a comma.',
      )
      setOpen(true)
      return
    }
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setLoading(true)
    setError('')
    setOpen(true)
    try {
      const matches = await geocodeDestination(query, controller.signal)
      if (controller.signal.aborted) return
      setRemoteResults(matches)
      setActiveIndex(0)
      if (matches.length === 1) selectLocation(matches[0])
      else if (!matches.length)
        setError('No places found. Try a country, a city with its country, or latitude, longitude.')
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : 'Place search is unavailable. Try again.')
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }

  const submit = () => {
    if (results.length && !error) selectLocation(results[Math.min(activeIndex, results.length - 1)])
    else void searchOnline()
  }

  return (
    <div className="header-search destination-search">
      <InputGroup className="search-field">
        <InputGroupInput
          ref={inputRef}
          value={query}
          onChange={(event) => updateQuery(event.target.value)}
          onFocus={() => {
            window.clearTimeout(blurTimer.current)
            setOpen(true)
          }}
          onBlur={() => {
            blurTimer.current = window.setTimeout(() => setOpen(false), 150)
          }}
          onKeyDown={(event) => {
            if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && results.length) {
              event.preventDefault()
              setOpen(true)
              setActiveIndex(
                (index) =>
                  (index + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length,
              )
            } else if (event.key === 'Enter') {
              event.preventDefault()
              submit()
            }
          }}
          maxLength={250}
          placeholder="Search place or coordinates"
          aria-label="Search place or coordinates"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={visible}
          aria-controls={visible ? listId : undefined}
          aria-activedescendant={
            visible && results.length
              ? `${listId}-${Math.min(activeIndex, results.length - 1)}`
              : undefined
          }
          autoComplete="off"
        />
        <InputGroupAddon>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="destination-submit"
            aria-label="Search destination"
            onMouseDown={(event) => event.preventDefault()}
            onClick={submit}
            disabled={loading || !query.trim()}
          >
            {loading ? (
              <SpinnerGapIcon size={18} className="destination-spinner" />
            ) : (
              <MagnifyingGlassIcon size={18} />
            )}
          </Button>
        </InputGroupAddon>
        {query && (
          <InputGroupAddon align="inline-end">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="search-clear"
              aria-label="Clear search"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                updateQuery('')
                inputRef.current?.focus()
              }}
            >
              <XIcon size={14} />
            </Button>
          </InputGroupAddon>
        )}
      </InputGroup>
      {visible && (
        <Command
          className="search-results destination-results"
          shouldFilter={false}
          value={results[Math.min(activeIndex, results.length - 1)]?.id ?? ''}
          aria-label="Suggested destinations"
        >
          <CommandList id={listId}>
            {results.map((location, index) => (
              <CommandItem
                key={location.id}
                id={`${listId}-${index}`}
                value={location.id}
                className="search-result destination-result"
                data-active={index === activeIndex || undefined}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setActiveIndex(index)}
                onSelect={() => selectLocation(location)}
              >
                {location.kind === 'coordinates' ? (
                  <CrosshairIcon size={16} />
                ) : (
                  <MapPinIcon size={16} />
                )}
                <span className="destination-result-copy">
                  <span>{location.name}</span>
                  <span className="destination-result-detail">
                    {location.description ||
                      `${location.kind === 'coordinates' ? 'Latitude, longitude' : location.kind[0].toUpperCase() + location.kind.slice(1)} · ${formatCoordinates(location.coordinates)}`}
                  </span>
                </span>
              </CommandItem>
            ))}
            {!coordinateTarget && !loading && remoteResults === null && (
              <CommandItem
                value="search-online"
                className="search-result destination-online"
                onMouseDown={(event) => event.preventDefault()}
                onSelect={() => void searchOnline()}
              >
                <MagnifyingGlassIcon size={15} />
                <span>Search all places for “{query.trim()}”</span>
              </CommandItem>
            )}
          </CommandList>
          {loading && (
            <p className="destination-status" role="status">
              Searching places.
            </p>
          )}
          {error && (
            <p className="destination-status destination-error" role="alert">
              {error}
            </p>
          )}
          {!loading && !results.length && !error && (
            <p className="destination-status">
              Press Enter to search places, or enter latitude, longitude.
            </p>
          )}
        </Command>
      )}
    </div>
  )
}

type CurrentLocationButtonProps = {
  onSelect: (location: LocationTarget) => void
  className?: string
}

export function CurrentLocationButton({ onSelect, className = '' }: CurrentLocationButtonProps) {
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const mounted = useRef(false)
  const pending = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  function requestLocation() {
    if (pending.current) return
    setMessage('')
    if (!window.isSecureContext) {
      setMessage('Current location requires HTTPS or localhost.')
      return
    }
    if (!navigator.geolocation) {
      setMessage('This browser does not support location sharing.')
      return
    }
    pending.current = true
    setLoading(true)
    try {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          pending.current = false
          if (!mounted.current) return
          setLoading(false)
          const { longitude, latitude, accuracy } = position.coords
          onSelect({
            id: `current:${longitude},${latitude}`,
            name: 'My current location',
            coordinates: [longitude, latitude],
            kind: 'current',
            accuracy,
            source: 'Browser location',
          })
        },
        (error) => {
          pending.current = false
          if (!mounted.current) return
          setLoading(false)
          setMessage(
            error.code === 1
              ? 'Location sharing is blocked. Enable it in your browser’s site permissions, then try again.'
              : error.code === 3
                ? 'Location request timed out. Try again.'
                : 'Your browser could not determine your location. Try again or search for a place.',
          )
        },
        { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
      )
    } catch {
      pending.current = false
      setLoading(false)
      setMessage(
        'Your browser could not request location access. Check this site’s location permissions.',
      )
    }
  }

  return (
    <div className="current-location-control">
      <Popover
        open={Boolean(message)}
        onOpenChange={(value) => {
          if (!value) setMessage('')
        }}
      >
        <Tooltip>
          <PopoverTrigger asChild>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={`current-location-button ${className}`}
                aria-label="Use my current location"
                aria-busy={loading}
                disabled={loading}
                onClick={requestLocation}
              >
                {loading ? (
                  <SpinnerGapIcon size={18} className="destination-spinner" />
                ) : (
                  <NavigationArrowIcon size={18} />
                )}
              </Button>
            </TooltipTrigger>
          </PopoverTrigger>
          <TooltipContent>
            {loading ? 'Waiting for browser location.' : 'Use my current location'}
          </TooltipContent>
        </Tooltip>
        {message && (
          <PopoverContent
            className="location-feedback"
            role="alert"
            align="center"
            side="top"
            collisionPadding={12}
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            <span>{message}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Dismiss location message"
              onClick={() => setMessage('')}
            >
              <XIcon size={15} />
            </Button>
          </PopoverContent>
        )}
      </Popover>
      {loading && (
        <span className="visually-hidden" role="status">
          Waiting for your browser’s location permission and position.
        </span>
      )}
    </div>
  )
}
