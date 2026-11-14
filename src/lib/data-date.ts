export function selectedDataDate(date: Date | undefined): string | null {
  // The calendar's civil date is the requested UTC data day. Do not convert a
  // local midnight via toISOString(), which would select yesterday in Warsaw.
  return date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` : null
}

