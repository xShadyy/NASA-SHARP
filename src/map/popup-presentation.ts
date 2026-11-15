export function popupField(parent: HTMLElement, label: string, value: unknown) {
  const row = document.createElement('p')
  const name = document.createElement('strong')
  name.textContent = `${label}: `
  row.append(
    name,
    document.createTextNode(value == null || value === '' ? 'Unknown' : String(value)),
  )
  parent.append(row)
}

export function popupControl(parent: HTMLElement, label: string, input: HTMLElement) {
  const wrapper = document.createElement('label')
  wrapper.className = 'fire-popup-control'
  const caption = document.createElement('span')
  caption.textContent = label
  input.setAttribute?.('data-popup-control', label)
  wrapper.append(caption, input)
  parent.append(wrapper)
}

export function popupAction(
  parent: HTMLElement,
  label: string,
  callback: () => void,
  disabled = false,
) {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.disabled = disabled
  button.addEventListener('click', callback)
  parent.append(button)
  return button
}

export function createCompactObservationCard(onOpenAnalytics: () => void) {
  const root = document.createElement('section')
  root.className = 'fire-popup fire-popup-group fire-popup-compact'
  const title = document.createElement('strong')
  title.className = 'fire-popup-drag-handle'
  title.textContent = 'Satellite hotspots'
  const actions = document.createElement('div')
  actions.className = 'fire-popup-actions fire-popup-compact-actions'
  const button = popupAction(actions, 'Open in Area Analytics', onOpenAnalytics)
  root.append(title, actions)
  return { root, button }
}

export function appendObservationScience(parent: HTMLElement, record: Record<string, unknown>) {
  const details = document.createElement('details')
  const title = document.createElement('summary')
  title.textContent = 'Scientific observation details'
  details.append(title)
  popupField(
    details,
    'Source / product',
    record.sourceProduct ?? record.provenance ?? record.source,
  )
  popupField(details, 'Processing tier', record.processingTier)
  popupField(details, 'Product version', record.productVersion)
  popupField(
    details,
    'Footprint interpretation',
    'Approximate sensor footprint around the canonical reported center, not a fire perimeter or burned area. Reported scan/track dimensions are used where available; nominal sensor dimensions are approximations.',
  )
  parent.append(details)
}

/** Refresh results without closing advanced filters or throwing away keyboard editing focus. */
export function preservePopupInteraction(root: HTMLElement) {
  const open = Array.from(root.querySelectorAll?.('details') ?? []).map((element) => element.open)
  const active = root.ownerDocument?.activeElement as HTMLInputElement | null
  const key = active && root.contains(active) ? active.getAttribute('data-popup-control') : null
  const start = active?.selectionStart,
    end = active?.selectionEnd
  return () => {
    Array.from(root.querySelectorAll?.('details') ?? []).forEach((element, index) => {
      if (open[index] != null) element.open = open[index]
    })
    if (!key) return
    const next = Array.from(root.querySelectorAll<HTMLElement>('[data-popup-control]')).find(
      (element) => element.getAttribute('data-popup-control') === key,
    )
    next?.focus({ preventScroll: true })
    if (next && 'setSelectionRange' in next && start != null && end != null) {
      try {
        ;(next as HTMLInputElement).setSelectionRange(start, end)
      } catch {
        /* Native numeric/date inputs have no text selection API. */
      }
    }
  }
}
