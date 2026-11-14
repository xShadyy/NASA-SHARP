import { writeFile } from 'node:fs/promises'
const url =
  'https://webservices.volcano.si.edu/geoserver/GVP-VOTW/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=GVP-VOTW:Smithsonian_VOTW_Holocene_Volcanoes&outputFormat=application/json'
const response = await fetch(url, { signal: AbortSignal.timeout(45_000) })
if (!response.ok) throw new Error(`GVP returned ${response.status}`)
const data = await response.json()
if (!Array.isArray(data.features) || data.features.length !== Number(data.totalFeatures))
  throw new Error('GVP returned an incomplete catalogue; existing asset retained.')
const features = data.features.map(({ properties: p, geometry }) => {
  if (
    geometry?.type !== 'Point' ||
    geometry.coordinates.length !== 2 ||
    !geometry.coordinates.every(Number.isFinite) ||
    Math.abs(geometry.coordinates[0]) > 180 ||
    Math.abs(geometry.coordinates[1]) > 90 ||
    !p.Volcano_Name
  )
    throw new Error('Invalid source geometry; existing asset retained.')
  return {
    type: 'Feature',
    id: p.Volcano_Number,
    geometry,
    properties: { name: p.Volcano_Name, number: p.Volcano_Number, country: p.Country },
  }
})
await writeFile(
  new URL('../public/map-data/holocene-volcanoes.geojson', import.meta.url),
  JSON.stringify({ type: 'FeatureCollection', features }),
)
console.log(
  `Saved ${features.length} factual Holocene volcano locations from Smithsonian GVP. Review the source citation/version before publishing.`,
)
