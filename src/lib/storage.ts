import { randomUUID } from 'crypto'

const SUPABASE_URL = process.env.SUPABASE_URL ?? ''
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const BUCKET = 'media'

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 // 5MB (matches the bucket limit)

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
}

export class UploadError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'UploadError'
  }
}

// Uploads an image to `${prefix}/${ownerId}/${uuid}.${ext}` in the public `media`
// bucket via the service-role key and returns its public URL. Validates mime + size.
export async function uploadImage(prefix: string, ownerId: string, file: File): Promise<string> {
  const ext = EXT_BY_MIME[file.type]
  if (!ext) throw new UploadError(400, '不支援的圖片格式，請使用 png、jpg 或 webp')

  const buf = Buffer.from(await file.arrayBuffer())
  if (buf.byteLength === 0) throw new UploadError(400, '檔案內容為空')
  if (buf.byteLength > MAX_UPLOAD_BYTES) throw new UploadError(413, '圖片過大，上限為 5MB')

  const path = `${prefix}/${ownerId}/${randomUUID()}.${ext}`
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      apikey: SERVICE_ROLE_KEY,
      'Content-Type': file.type,
      'cache-control': '3600',
    },
    body: buf,
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new UploadError(502, `儲存空間上傳失敗：${detail.slice(0, 200)}`)
  }

  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`
}
