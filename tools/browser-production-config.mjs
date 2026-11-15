import { resolve } from 'node:path'
import original from '../vite.config.ts'


export default async function browserProductionConfig(environment) {
  const configuration = typeof original === 'function' ? await original(environment) : original
  if (process.env.SHARP_LEGACY_GLOBAL_BENCHMARK !== '1') return configuration
  const aliases = configuration.resolve?.alias || {}
  return {
    ...configuration,
    resolve: {
      ...configuration.resolve,
      alias: [
        {
          find: '@/map/global-raster-controller',
          replacement: resolve('tools/legacy-global-benchmark-adapter.ts'),
        },
        ...(Array.isArray(aliases)
          ? aliases
          : Object.entries(aliases).map(([find, replacement]) => ({ find, replacement }))),
      ],
    },
  }
}
