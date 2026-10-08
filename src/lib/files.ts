import { BRIDGE_HTTP_URL } from '../config'

export const fileUrl = (path: string, download = false) =>
  `${BRIDGE_HTTP_URL}/files/raw?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export const TEXT_PREVIEW_LIMIT = 512_000
