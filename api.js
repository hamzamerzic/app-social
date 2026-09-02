// Common — calls to this instance's federation endpoints. The backend owns
// signing, delivery, and peer verification; the app only ever talks to its
// own server.

let bearer = null
export function setToken(token) { bearer = token }

async function call(path, options = {}, responseType = 'json') {
  const response = await fetch(`/api/common/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${bearer}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  })
  if (!response.ok) {
    let detail = ''
    try { detail = (await response.json()).detail || '' } catch { /* opaque */ }
    const error = new Error(detail || `Request failed (${response.status}).`)
    error.status = response.status
    throw error
  }
  if (responseType === 'blob') return response.blob()
  if (responseType === 'none') return null
  return response.json()
}

export const getMe = () => call('me')
export const join = () => call('join', { method: 'POST', body: JSON.stringify({}) })
export const saveMe = (settings) =>
  call('me', { method: 'PUT', body: JSON.stringify(settings) })
export const sendMessage = (to, text, peerHandle, attachment, replyTo) =>
  call('send', {
    method: 'POST',
    body: JSON.stringify({
      to,
      text,
      ...(peerHandle ? { peer_handle: peerHandle } : {}),
      ...(attachment ? { attachment } : {}),
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  })
export const publishPost = (text, attachment) =>
  call('publish', {
    method: 'POST',
    body: JSON.stringify({ text, ...(attachment ? { attachment } : {}) }),
  })
export const getFeed = () => call('feed')
export const getBoardMedia = (postId) =>
  call(`board-media/${encodeURIComponent(postId)}`, {}, 'blob')
export const likePost = (postId) =>
  call('like', { method: 'POST', body: JSON.stringify({ post_id: postId }) })
export const getReplies = (postId) =>
  call(`board/${encodeURIComponent(postId)}/replies`)
export const postReply = (postId, text) =>
  call('reply', { method: 'POST', body: JSON.stringify({ post_id: postId, text }) }, 'none')
export const searchPeople = (q) => call(`people?q=${encodeURIComponent(q)}`)
export const getPeer = (host) => call(`peer/${encodeURIComponent(host)}`)
export async function getAppIcon(appId) {
  const response = await fetch(`/api/apps/${appId}/icon`, {
    headers: { Authorization: `Bearer ${bearer}` },
  })
  if (!response.ok) throw new Error('icon unavailable')
  return response.blob()
}
export const getPeerAvatar = (host) =>
  call(`peer-avatar/${encodeURIComponent(host)}`, {}, 'blob')

// ── conversation storage (each side keeps only its own copy) ────────────────

export async function listConversations() {
  const store = window.mobius?.storage
  if (!store) return []
  const entries = await store.list('conversations/')
  const dirs = entries.filter((e) => e.type === 'dir')
  const metas = await Promise.all(
    dirs.map((d) => store.get(`conversations/${d.name}/meta.json`).catch(() => null))
  )
  return metas
    .filter(Boolean)
    .sort((a, b) => (b.last_at || 0) - (a.last_at || 0))
}

export async function listMessages(peer) {
  const store = window.mobius?.storage
  if (!store) return []
  const entries = await store.list(`conversations/${peer}/msgs/`, { includeContent: true })
  const loaded = await Promise.all(
    entries.map((e) => (e.content !== undefined ? e.content : store.get(e.path).catch(() => null)))
  )
  return loaded.filter(Boolean).sort((a, b) => (a.sent_at || 0) - (b.sent_at || 0))
}

export async function clearUnread(peer) {
  const store = window.mobius?.storage
  if (!store) return
  const path = `conversations/${peer}/meta.json`
  const meta = await store.get(path).catch(() => null)
  if (meta && meta.unread) await store.set(path, { ...meta, unread: 0 })
}

// ── groups ──────────────────────────────────────────────────────────────────

export const createGroup = (name, members) =>
  call('groups', { method: 'POST', body: JSON.stringify({ name, members }) })
export const sendGroupMessage = (gid, text, attachment, replyTo) =>
  call(`groups/${encodeURIComponent(gid)}/send`, {
    method: 'POST',
    body: JSON.stringify({
      text,
      ...(attachment ? { attachment } : {}),
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  })

export async function listGroups() {
  const store = window.mobius?.storage
  if (!store) return []
  const entries = await store.list('groups/')
  const dirs = entries.filter((e) => e.type === 'dir')
  const metas = await Promise.all(
    dirs.map((d) => store.get(`groups/${d.name}/meta.json`).catch(() => null))
  )
  return metas.filter(Boolean)
}

export async function listGroupMessages(gid) {
  const store = window.mobius?.storage
  if (!store) return []
  const entries = await store.list(`groups/${gid}/msgs/`, { includeContent: true })
  const loaded = await Promise.all(
    entries.map((e) => (e.content !== undefined ? e.content : store.get(e.path).catch(() => null)))
  )
  return loaded.filter(Boolean).sort((a, b) => (a.sent_at || 0) - (b.sent_at || 0))
}

export async function clearGroupUnread(gid) {
  const store = window.mobius?.storage
  if (!store) return
  const path = `groups/${gid}/meta.json`
  const meta = await store.get(path).catch(() => null)
  if (meta && meta.unread) await store.set(path, { ...meta, unread: 0 })
}

// ── helpers ─────────────────────────────────────────────────────────────────

const AVATAR_HUES = [258, 12, 165, 205, 32, 315, 122, 352]
export function avatarHue(host) {
  let hash = 0
  for (const ch of String(host)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return AVATAR_HUES[hash % AVATAR_HUES.length]
}

export function initials(name, host) {
  const source = (name || '').trim() || String(host || '?')
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return source.slice(0, 2).toUpperCase()
}

export function timeAgo(ts) {
  if (!ts) return ''
  const seconds = Math.max(0, Date.now() / 1000 - ts)
  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  const date = new Date(ts * 1000)
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function clockTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit',
  })
}
