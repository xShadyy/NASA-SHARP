import { Separator } from '@/components/ui/separator'
import './MapCredits.css'

const credits = [
  {
    label: 'NASA FIRMS: MODIS Collection 6.1 and VIIRS 375 m Collection 2 NRT observations',
    href: 'https://firms.modaps.eosdis.nasa.gov/content/active_fire/',
  },
  { label: 'NASA GIBS', href: 'https://nasa-gibs.github.io/gibs-api-docs/' },
  {
    label: 'Blue Marble / NASA Earth Observatory',
    href: 'https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-topography-bathymetry/',
  },
  {
    label: 'Human built-up extent: NASA GIBS / SEDAC - Landsat HBASE (2010)',
    href: 'https://data.nasa.gov/dataset/global-human-built-up-and-settlement-extent-hbase-dataset-from-landsat',
  },
  {
    label:
      'UNEP-WCMC and IUCN (2026), Protected Planet: The World Database on Protected and Conserved Areas (WDPCA) [On-line], [November 2026], Cambridge, UK: UNEP-WCMC and IUCN. Protected areas only.',
    href: 'https://www.protectedplanet.net/',
  },
  { label: 'Protected Planet data terms', href: 'https://www.protectedplanet.net/en/legal' },
  {
    label:
      'European protected areas: © European Environment Agency, Copenhagen (2025) - Natura 2000 (2024)',
    href: 'https://www.eea.europa.eu/en/datahub/datahubitem-view/6fc8ad2d-195d-40f4-bdec-576e7d1268e4',
  },
  {
    label: 'Landsat 8 and 9 archived scene footprints: NASA CMR / LP DAAC / USGS - HLS L30',
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
      'Country analysis boundaries: geoBoundaries gbOpen 6.0.0 - CC BY 4.0 and original source licenses',
    href: 'https://github.com/wmgeolab/geoBoundaries/tree/1289e40e366c7b320550be1ee0614a9472d572d4/releaseData/gbOpen',
  },
  { label: 'Place search: Photon / OpenStreetMap', href: 'https://photon.komoot.io/' },
  {
    label:
      'Sky: NASA/Goddard Space Flight Center Scientific Visualization Studio - Gaia DR2: ESA/Gaia/DPAC',
    href: 'https://svs.gsfc.nasa.gov/4851/',
  },
  {
    label: 'Gaia DR2 acknowledgements: ESA/Gaia/DPAC',
    href: 'https://gea.esac.esa.int/archive/documentation/GDR2/Miscellaneous/sec_credit_and_citation_instructions/',
  },
  {
    label: 'OpenMapTiles schema and cartography licenses',
    href: 'https://github.com/openmaptiles/openmaptiles/blob/master/LICENSE.md',
  },
  { label: 'Fira Sans 4.203 - SIL Open Font License 1.1', href: '/brand/fonts/OFL.txt' },
  { label: 'Third-party software licenses and notices', href: '/legal/THIRD-PARTY-LICENSES.txt' },
  { label: 'SHARP source code - Apache License 2.0', href: '/legal/LICENSE' },
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
