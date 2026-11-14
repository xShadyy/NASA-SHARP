/** Decode a map tile for color-based categorical overlays. */
export async function decodePixels(blob: Blob): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob)
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bitmap, 0, 0); bitmap.close()
  return ctx.getImageData(0, 0, canvas.width, canvas.height)
}

export function pixelBitmap(pixels: ImageData) {
  const canvas = new OffscreenCanvas(pixels.width, pixels.height)
  canvas.getContext('2d')!.putImageData(pixels, 0, 0)
  return canvas.transferToImageBitmap()
}
