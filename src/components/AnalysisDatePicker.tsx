import { useRef, useState } from 'react'
import { CaretLeftIcon, CaretRightIcon } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import {
  MODIS_START_DAY,
  addUtcDays,
  calendarWeeks,
  clampRange,
  formatUtcDay,
  formatUtcRange,
  rangePreset,
  shiftMonth,
  utcToday,
  type AnalysisRange,
} from '@/lib/analysis-activity'

export function AnalysisDatePicker({
  range,
  onChange,
}: {
  range: AnalysisRange
  onChange: (range: AnalysisRange) => void
}) {
  const [month, setMonth] = useState(range.start.slice(0, 7))
  const [view, setView] = useState<'days' | 'months' | 'years'>('days')
  const [yearPage, setYearPage] = useState(Math.floor(Number(month.slice(0, 4)) / 12) * 12)
  const [preview, setPreview] = useState<AnalysisRange | null>(null)
  const drag = useRef<{ anchor: string; range: AnalysisRange } | null>(null)
  const suppressClick = useRef(false)
  const today = utcToday()
  const year = Number(month.slice(0, 4))
  const selection = preview ?? range
  const monthLabel = new Intl.DateTimeFormat('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${month}-01T00:00:00Z`))

  function dayAt(x: number, y: number) {
    return document
      .elementFromPoint(x, y)
      ?.closest<HTMLButtonElement>('button[data-period-day]:not(:disabled)')?.dataset.periodDay
  }

  function finish() {
    if (!drag.current) return
    onChange(drag.current.range)
    drag.current = null
    setPreview(null)
  }

  const canPrevious =
    view === 'years'
      ? yearPage > 2000
      : view === 'months'
        ? year > 2000
        : month > MODIS_START_DAY.slice(0, 7)
  const canNext =
    view === 'years'
      ? yearPage + 12 <= Number(today.slice(0, 4))
      : view === 'months'
        ? year < Number(today.slice(0, 4))
        : month < today.slice(0, 7)

  function navigate(amount: number) {
    if (view === 'years') setYearPage((current) => current + amount * 12)
    else if (view === 'months') setMonth(`${year + amount}-${year + amount === 2000 ? '11' : '01'}`)
    else setMonth(shiftMonth(month, amount))
  }

  return (
    <div className="analysis-date-picker">
      <div className="analysis-presets" aria-label="Date presets">
        {(['24h', '7d', 'month'] as const).map((preset) => (
          <Button
            key={preset}
            size="sm"
            variant="outline"
            aria-pressed={range.preset === preset}
            onClick={() => {
              const next = rangePreset(preset)
              onChange(next)
              setMonth(next.end.slice(0, 7))
              setView('days')
            }}
          >
            {preset === '24h' ? 'Last 24h' : preset === '7d' ? 'Last 7 days' : 'Last month'}
          </Button>
        ))}
      </div>
      <p className="analysis-period-selection">
        {range.preset === '24h' ? 'Last 24 hours' : formatUtcRange(selection)} UTC
      </p>
      <div className="analysis-date-nav">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Previous"
          disabled={!canPrevious}
          onClick={() => navigate(-1)}
        >
          <CaretLeftIcon size={16} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Choose year"
          onClick={() => {
            setYearPage(Math.floor(year / 12) * 12)
            setView('years')
          }}
        >
          {view === 'years'
            ? `${Math.max(2000, yearPage)}-${Math.min(Number(today.slice(0, 4)), yearPage + 11)}`
            : view === 'months'
              ? year
              : monthLabel}
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Next"
          disabled={!canNext}
          onClick={() => navigate(1)}
        >
          <CaretRightIcon size={16} />
        </Button>
      </div>
      {view === 'years' && (
        <div className="analysis-date-options">
          {Array.from({ length: 12 }, (_, index) => yearPage + index).map((item) => (
            <Button
              key={item}
              variant="ghost"
              size="sm"
              disabled={item < 2000 || item > Number(today.slice(0, 4))}
              onClick={() => {
                setMonth(`${item}-${item === 2000 ? '11' : '01'}`)
                setView('months')
              }}
            >
              {item}
            </Button>
          ))}
        </div>
      )}
      {view === 'months' && (
        <div className="analysis-date-options">
          {Array.from(
            { length: 12 },
            (_, index) => `${year}-${String(index + 1).padStart(2, '0')}`,
          ).map((item) => (
            <Button
              key={item}
              variant="ghost"
              size="sm"
              disabled={item < MODIS_START_DAY.slice(0, 7) || item > today.slice(0, 7)}
              onClick={() => {
                setMonth(item)
                setView('days')
              }}
            >
              {new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' }).format(
                new Date(`${item}-01T00:00:00Z`),
              )}
            </Button>
          ))}
        </div>
      )}
      {view === 'days' && (
        <div
          className="analysis-date-days"
          role="group"
          aria-label="Select a day or drag a date range"
          onPointerDown={(event) => {
            if (event.button !== 0) return
            const day = dayAt(event.clientX, event.clientY)
            if (!day) return
            suppressClick.current = true
            drag.current = { anchor: day, range: clampRange(day, day) }
            setPreview(drag.current.range)
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            if (!drag.current) return
            const day = dayAt(event.clientX, event.clientY)
            if (!day) return
            drag.current.range = clampRange(drag.current.anchor, day)
            setPreview(drag.current.range)
          }}
          onPointerUp={finish}
          onLostPointerCapture={finish}
          onPointerCancel={() => {
            drag.current = null
            setPreview(null)
            suppressClick.current = false
          }}
        >
          {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((day) => (
            <span key={day} className="analysis-date-weekday">
              {day}
            </span>
          ))}
          {calendarWeeks(month)
            .flat()
            .map((day) => (
              <button
                key={day}
                type="button"
                data-period-day={day}
                disabled={day < MODIS_START_DAY || day > today}
                data-outside={day.slice(0, 7) !== month || undefined}
                data-endpoint={day === selection.start || day === selection.end || undefined}
                aria-label={formatUtcDay(day)}
                aria-pressed={day >= selection.start && day <= selection.end}
                onClick={(event) => {
                  if (event.detail !== 0 && suppressClick.current) {
                    suppressClick.current = false
                    return
                  }
                  onChange(event.shiftKey ? clampRange(range.start, day) : clampRange(day, day))
                }}
                onKeyDown={(event) => {
                  const amount = (
                    { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<
                      string,
                      number
                    >
                  )[event.key]
                  if (!amount) return
                  event.preventDefault()
                  const next = addUtcDays(day, amount)
                  if (next < MODIS_START_DAY || next > today) return
                  if (event.shiftKey) onChange(clampRange(range.start, next))
                  if (next.slice(0, 7) !== month) setMonth(next.slice(0, 7))
                  requestAnimationFrame(() =>
                    document
                      .querySelector<HTMLButtonElement>(`[data-period-day="${next}"]`)
                      ?.focus(),
                  )
                }}
              >
                {Number(day.slice(8))}
              </button>
            ))}
        </div>
      )}
      <p className="analysis-period-note">Click a day or drag to select up to 31 days.</p>
    </div>
  )
}
