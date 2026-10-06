import { getBoardMedia, getReplyMedia } from './api.js'

// A board thumbnail never changes for its post and index. Social's frame is a
// sandboxed, opaque-origin document, and Chrome gives each such document its
// own HTTP cache partition, so even a cacheable response is fetched again on
// every launch. App storage is answered from the device instead, so saved
// thumbnails paint at once. Only the newest THUMBNAIL_LIMIT are kept; the list
// lives in memory for the session and is written back at most once a second.
export const THUMBNAIL_LIMIT = 60
const INDEX_PATH = 'cache/board-thumbnails/index.json'
const INDEX_WRITE_DELAY_MS = 1000
const thumbnailPath = (postId, index, replyId) => replyId
  ? `cache/board-thumbnails/reply-${encodeURIComponent(postId)}-${encodeURIComponent(replyId)}.webp`
  : `cache/board-thumbnails/${encodeURIComponent(postId)}-${index ?? 0}.webp`

const appStorage = () => globalThis.window?.mobius?.storage
const indexes = new WeakMap()
let indexWrite = null

function loadIndex(store) {
  if (!indexes.has(store)) {
    indexes.set(store, Promise.resolve(store.get(INDEX_PATH))
      .then(saved => (Array.isArray(saved?.paths) ? saved.paths : []), () => []))
  }
  return indexes.get(store)
}

async function rememberThumbnail(store, path, blob) {
  const paths = await loadIndex(store)
  await store.setBlob(path, blob)
  const known = paths.indexOf(path)
  if (known !== -1) paths.splice(known, 1)
  paths.push(path)
  const expired = paths.splice(0, Math.max(0, paths.length - THUMBNAIL_LIMIT))
  clearTimeout(indexWrite)
  indexWrite = setTimeout(() => {
    Promise.resolve(store.set(INDEX_PATH, { paths })).catch(() => {})
  }, INDEX_WRITE_DELAY_MS)
  await Promise.all(expired.map(item => Promise.resolve(store.remove(item)).catch(() => null)))
}

export async function boardThumbnail(postId, index, replyId) {
  const store = appStorage()
  const path = thumbnailPath(postId, index, replyId)
  const usable = typeof store?.getBlob === 'function' && typeof store?.setBlob === 'function'
    && typeof store?.get === 'function' && typeof store?.set === 'function'
  // Only ask storage for thumbnails this device saved; a miss would cost a
  // round trip before the service request.
  if (usable && (await loadIndex(store)).includes(path)) {
    try {
      const saved = await store.getBlob(path)
      if (saved?.size) return saved
    } catch { /* fall through to the service */ }
  }
  const blob = replyId
    ? await getReplyMedia(postId, replyId, { thumbnail: true })
    : await getBoardMedia(postId, index, { thumbnail: true })
  if (blob?.size && usable) rememberThumbnail(store, path, blob).catch(() => {})
  return blob
}
