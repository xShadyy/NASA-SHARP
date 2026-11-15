export function outlookExpired(
  outlook: { state: string; validEnd?: string } | null | undefined,
  now: number,
) {
  if (outlook?.state !== 'experimental-forecast') return false
  const expiry = Date.parse(outlook.validEnd ?? '')
  return !Number.isFinite(expiry) || expiry <= now
}
