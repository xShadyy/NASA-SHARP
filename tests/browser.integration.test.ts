import test from 'node:test'
import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { browserIntegration } from '../tools/browser-integration.mjs'


const marker = '.cache/browser-tests/run'
const diagnosticMarker = '.cache/browser-tests/startup-diagnostic'
const diagnostic = existsSync(diagnosticMarker)
const enabled =
  process.env.SHARP_BROWSER_TEST === '1' || existsSync(marker) || existsSync(diagnosticMarker)
test(
  diagnostic
    ? 'startup browser integration against the running local canonical store'
    : 'browser integration against temporary synthetic canonical databases',
  { timeout: 300000, skip: !enabled },
  async () => {
    try {
      if (diagnostic) {
        await import('../tools/browser-startup-diagnostic.mjs')
      } else {
        const result = await browserIntegration()
        console.log(JSON.stringify(result))
      }
    } finally {
      await unlink(marker).catch(() => {})
      await unlink(diagnosticMarker).catch(() => {})
    }
  },
)
