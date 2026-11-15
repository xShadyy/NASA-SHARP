import { firePixelFeatures, type FireFeature } from '@/lib/fire-severity'

self.onmessage = (event: MessageEvent<{ revision: number; features: FireFeature[] }>) => {
  try {
    self.postMessage({
      revision: event.data.revision,
      features: firePixelFeatures(event.data.features),
    })
  } catch {
    self.postMessage({ revision: event.data.revision, features: [] })
  }
}
