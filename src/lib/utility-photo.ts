import type { UtilityPhotoInput } from "@/lib/utilities"

const MAX_SOURCE_BYTES = 12_000_000
const TARGET_BYTES = 260_000
export const MAX_UTILITY_PHOTO_BYTES = 300_000

export interface UtilityPhotoDraft extends UtilityPhotoInput {
  byte_size: number
  preview_url: string
}

interface LoadedImage {
  source: CanvasImageSource
  width: number
  height: number
  close: () => void
}

async function loadImage(file: File): Promise<LoadedImage> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file)
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      }
    } catch {
      // Le repli HTMLImageElement gère certains formats que createImageBitmap
      // refuse suivant le navigateur ou le réglage du téléphone.
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    }
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("La compression de la photo a échoué.")),
      "image/jpeg",
      quality,
    )
  })
}

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? "")
      resolve(result.slice(result.indexOf(",") + 1))
    }
    reader.onerror = () => reject(new Error("Impossible de lire la photo compressée."))
    reader.readAsDataURL(blob)
  })
}

/** Compresse une photo de compteur pour deux justificatifs dans le JSON de 1 Mo. */
export async function compressUtilityPhoto(file: File): Promise<UtilityPhotoDraft> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error("Utilisez une photo JPEG, PNG ou WebP.")
  }
  if (file.size <= 0 || file.size > MAX_SOURCE_BYTES) {
    throw new Error("La photo d'origine doit peser entre 1 octet et 12 Mo.")
  }
  const image = await loadImage(file)
  if (!image.width || !image.height) {
    image.close()
    throw new Error("Cette image ne peut pas être lue.")
  }

  try {
    const canvas = document.createElement("canvas")
    const context = canvas.getContext("2d")
    if (!context) throw new Error("Votre navigateur ne permet pas de compresser cette photo.")
    const attempts = [
      { edge: 1280, quality: 0.74 },
      { edge: 1024, quality: 0.64 },
      { edge: 896, quality: 0.54 },
      { edge: 768, quality: 0.44 },
    ]
    let compressed: Blob | null = null
    for (const attempt of attempts) {
      const scale = Math.min(1, attempt.edge / Math.max(image.width, image.height))
      canvas.width = Math.max(1, Math.round(image.width * scale))
      canvas.height = Math.max(1, Math.round(image.height * scale))
      context.clearRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image.source, 0, 0, canvas.width, canvas.height)
      compressed = await canvasBlob(canvas, attempt.quality)
      if (compressed.size <= TARGET_BYTES) break
    }
    if (!compressed || compressed.size > MAX_UTILITY_PHOTO_BYTES) {
      throw new Error("La photo reste trop volumineuse après compression. Prenez une vue plus proche du cadran.")
    }
    const dataBase64 = await blobBase64(compressed)
    return {
      mime_type: "image/jpeg",
      data_base64: dataBase64,
      byte_size: compressed.size,
      preview_url: `data:image/jpeg;base64,${dataBase64}`,
    }
  } finally {
    image.close()
  }
}
