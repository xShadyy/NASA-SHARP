import test from 'node:test'
import assert from 'node:assert/strict'
import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ActivityTrend } from '../src/components/AnalysisActivity'
import { customAnalysisRange, eachUtcDay } from '../src/lib/analysis-activity'

// tsx's root test configuration uses the classic JSX transform.
Object.assign(globalThis, { React })

test('custom first/end selection spans months, includes leap day, reverses safely, rejects oversized ranges', () => {
  assert.deepEqual(customAnalysisRange('2024-03-02', '2024-02-28'), {
    start: '2024-02-28',
    end: '2024-03-02',
  })
  assert.equal(eachUtcDay('2024-02-28', '2024-03-02').length, 4)
  assert.deepEqual(customAnalysisRange('2024-01-01', '2024-01-31'), {
    start: '2024-01-01',
    end: '2024-01-31',
  })
  assert.deepEqual(customAnalysisRange('2024-01-01', '2024-02-01'), {
    start: '2024-01-01',
    end: '2024-02-01',
  })
  assert.throws(() => customAnalysisRange('1900-01-01', '2024-02-01'), /100 years/)
})

test('harmonized trend keeps full interval under focus and distinguishes successful zero from missing coverage', () => {
  const days = ['2024-02-28', '2024-02-29', '2024-03-01']
  const html = renderToStaticMarkup(
    createElement(ActivityTrend, {
      days,
      series: [],
      focusedDay: '2024-03-01',
      onFocusDay: () => {},
      calendar: days.map((date, index) => ({
        date,
        count: index === 1 ? null : index * 2,
        state: index === 1 ? 'unavailable' : 'complete',
        coverage: index === 1 ? 'Missing reporting window' : 'Complete reporting window',
      })),
    }),
  )
  assert.equal((html.match(/role="button"/g) ?? []).length, 3)
  assert.match(html, /0 harmonized active cells/)
  assert.match(html, /Unavailable harmonized active cells/)
  assert.match(html, /Missing reporting window/)
  assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 2) // Default view and focused day.
  assert.match(html, /28 February 2024|28 Feb 2024/)
  assert.match(html, /By satellite/)
})
