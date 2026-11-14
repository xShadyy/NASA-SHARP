import { Separator } from '@/components/ui/separator'
import './MapCredits.css'

const credits = [
  { label: 'NASA GIBS', href: 'https://nasa-gibs.github.io/gibs-api-docs/' },
  {
    label: 'Blue Marble / NASA Earth Observatory',
    href: 'https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-topography-bathymetry/',
  },
  {
    label: 'Human built-up extent: NASA GIBS / SEDAC · Landsat HBASE (2010)',
    href: 'https://sedac.ciesin.columbia.edu/data/set/landsat-hbase-v1',
  },
  {
    label:
      'UNEP-WCMC and IUCN (2026), Protected Planet: The World Database on Protected and Conserved Areas (WDPCA) [On-line], [October 2026], Cambridge, UK: UNEP-WCMC and IUCN. Protected areas only.',
    href: 'https://www.protectedplanet.net/',
  },
  {
    label:
      'European protected areas: © European Environment Agency, Copenhagen (2025) · Natura 2000 (2024)',
    href: 'https://bio.discomap.eea.europa.eu/arcgis/rest/services/ProtectedSites/Natura2000Sites/MapServer',
  },
  {
    label: 'Landsat 8 and 9 archived scene footprints: NASA CMR / LP DAAC / USGS · HLS L30',
    href: 'https://lpdaac.usgs.gov/products/hlsl30v002/',
  },
  {
    label:
      'Known volcanoes: Smithsonian / Global Volcanism Program, Volcanoes of the World v5.4.0 (Venzke, 2026)',
    href: 'https://doi.org/10.5479/si.GVP.VOTW5-2026.5.4',
  },
  { label: 'OpenFreeMap', href: 'https://openfreemap.org/' },
  { label: '© OpenMapTiles', href: 'https://www.openmaptiles.org/' },
  { label: '© OpenStreetMap contributors', href: 'https://www.openstreetmap.org/copyright' },
  { label: 'Natural Earth', href: 'https://www.naturalearthdata.com/about/terms-of-use/' },
  {
    label:
      'Country analysis boundaries: geoBoundaries gbOpen 6.0.0 · CC BY 4.0 and original source licenses',
    href: 'https://github.com/wmgeolab/geoBoundaries/tree/1289e40e366c7b320550be1ee0614a9472d572d4/releaseData/gbOpen',
  },
  { label: 'Place search: Photon / OpenStreetMap', href: 'https://photon.komoot.io/' },
  {
    label:
      'Sky: NASA/Goddard Space Flight Center Scientific Visualization Studio · Gaia DR2: ESA/Gaia/DPAC',
    href: 'https://svs.gsfc.nasa.gov/4851/',
  },
  { label: 'Sky source & display notes', href: '/sky/README.md' },
  { label: 'Style credits', href: '/map-data/STYLE-NOTICES.md' },
]

export function MapCredits() {
  return (
    <section className="map-credits" aria-labelledby="map-credits-heading">
      <Separator className="map-credits-divider" />
      <h3 id="map-credits-heading">Sources and attribution</h3>
      <ul>
        {credits.map(({ label, href }) => (
          <li key={label}>
            <a href={href} target="_blank" rel="noopener noreferrer">
              {label}
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}
