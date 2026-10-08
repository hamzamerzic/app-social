
export const PARTICIPATION_INTENT_PATH = 'drafts/board-participation.json'

import {
  attachmentBytes, galleryFitsMediaLimits, GIF_MAX_BYTES, IMAGE_MAX_BYTES,
  THUMBNAIL_MAX_BYTES,
} from './media_limits.js'

const INTENT_VERSION = 1
const TEXT_LIMITS = { post: 4000, reply: 1000 }
const INTENT_KINDS = new Set(['post', 'reply', 'like'])
const POST_ID_RE = /^[a-z0-9-]{1,128}$/i
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const REACTION_EMOJIS = new Set([
  '❤️', '👍', '👎', '😂', '😮', '😢', '😡', '🎉', '🚀', '👀', '🙌', '🔥',
  '✅', '💯', '🤔', '👏', '🙏', '💪', '🤝', '✨', '😍', '🤯', '🫡', '🫶',
])

const MAX_INTENT_ATTACHMENTS = 4

function normalizedAttachment(value, thumbnailLimit = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { mime, data_b64: data, w, h } = value
  if (
    !(thumbnailLimit == null ? mime === 'image/gif' || IMAGE_MIME_TYPES.has(mime) : IMAGE_MIME_TYPES.has(mime))
    || typeof data !== 'string'
    || !data.length
    || data.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
    || attachmentBytes(value) > (thumbnailLimit ?? (mime === 'image/gif' ? GIF_MAX_BYTES : IMAGE_MAX_BYTES))
    || !Number.isInteger(w) || w < 1 || w > 8192
    || !Number.isInteger(h) || h < 1 || h > 8192
  ) return null
  return { mime, data_b64: data, w, h }
}

function normalizedAttachments(value, thumbnailLimit = null) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_INTENT_ATTACHMENTS) {
    return null
  }
  const out = []
  for (const item of value) {
    const one = normalizedAttachment(item, thumbnailLimit)
    if (!one) return null
    out.push(one)
  }
  return out
}

function normalizedIntent(kind, values = {}, legacyThumbnail = false) {
  if (!INTENT_KINDS.has(kind)) return null
  const intent = { version: INTENT_VERSION, kind }

  if (kind === 'post' || kind === 'reply') {
    const limit = TEXT_LIMITS[kind]
    intent.text = String(values.text || '').slice(0, limit)
  }
  if (kind === 'reply' || kind === 'like') {
    const postId = String(values.postId || values.post_id || '').trim()
    if (!POST_ID_RE.test(postId)) return null
    intent.post_id = postId
  }
  if (kind === 'like') {
    intent.emoji = REACTION_EMOJIS.has(values.emoji) ? values.emoji : '❤️'
  }
  if (kind === 'post') {
    // Older saved drafts used a 1.4M-character thumbnail ceiling. Continue
    // reading those exact drafts, but require the current 120 KiB limit for
    // anything newly created or saved.
    const thumbnailLimit = legacyThumbnail ? 1_050_000 : THUMBNAIL_MAX_BYTES
    const thumbnails = values.thumbnails == null ? null : normalizedAttachments(values.thumbnails, thumbnailLimit)
    if (values.thumbnails != null && !thumbnails) return null
    if (thumbnails) intent.thumbnails = thumbnails
    const attachments = values.attachments == null ? null : normalizedAttachments(values.attachments)
    if (values.attachments != null && !attachments) return null
    if (attachments) {
      if (!galleryFitsMediaLimits(attachments)) return null
      intent.attachments = attachments
    } else {
      const attachment = values.attachment == null ? null : normalizedAttachment(values.attachment)
      if (values.attachment != null && !attachment) return null
      if (attachment) intent.attachment = attachment
    }
  }
  if (kind === 'reply') {
    const attachment = values.attachment == null ? null : normalizedAttachment(values.attachment)
    if (values.attachment != null && !attachment) return null
    if (attachment) {
      intent.attachment = attachment
      const thumbnail = values.thumbnail == null ? null : normalizedAttachment(
        values.thumbnail, legacyThumbnail ? 1_050_000 : THUMBNAIL_MAX_BYTES,
      )
      if (values.thumbnail != null && !thumbnail) return null
      if (thumbnail) intent.thumbnail = thumbnail
    } else if (values.thumbnail != null) {
      return null
    }
  }
  return intent
}

export function createParticipationIntent(kind, values = {}) {
  return normalizedIntent(kind, values)
}

export function parseParticipationIntent(value) {
  if (!value || value.version !== INTENT_VERSION) return null
  return normalizedIntent(value.kind, value, true)
}

export function participationIntentMatches(first, second) {
  const a = parseParticipationIntent(first)
  const b = parseParticipationIntent(second)
  if (!a || !b) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

export async function loadParticipationIntent(storage) {
  if (!storage?.get) return null
  return parseParticipationIntent(await storage.get(PARTICIPATION_INTENT_PATH))
}

export async function saveParticipationIntent(storage, intent) {
  const safe = intent?.version === INTENT_VERSION && normalizedIntent(intent.kind, intent)
  if (!safe || !storage?.getWithVersion || !storage?.durableWrite) return false
  const { value, version, offline } = await storage.getWithVersion(PARTICIPATION_INTENT_PATH)
  if (offline) throw new Error('Reconnect before leaving Social so your draft can be saved safely.')
  if (value != null) {
    if (participationIntentMatches(value, safe)) return true
    throw new Error('You already have a saved action. Finish that draft before starting another; it has not been replaced.')
  }
  await storage.durableWrite(PARTICIPATION_INTENT_PATH, safe,
    version == null ? { ifNoneMatch: true } : { ifMatch: version })
  return true
}

export async function clearParticipationIntent(storage, expectedIntent) {
  if (!storage?.getWithVersion || !storage?.durableWrite) return false
  const { value, version, offline } = await storage.getWithVersion(PARTICIPATION_INTENT_PATH)
  if (offline || version == null || !participationIntentMatches(value, expectedIntent)) return false
  await storage.durableWrite(PARTICIPATION_INTENT_PATH, null, { ifMatch: version })
  return true
}

// Everything public in Social is shown by handle, so a linked account still
// chooses a username in Möbius · You before it can join or take part.
export function participationStep(profile) {
  if (profile?.joined && profile?.handle) return 'ready'
  if (profile?.connected && profile?.handle) return 'join'
  if (profile?.connected) return 'username'
  return profile?.identity_app_id == null ? 'store' : 'identity'
}

export function participationActionLabel(step, intentKind = 'post') {
  if (step === 'ready') {
    if (intentKind === 'reply') return 'Review reply'
    if (intentKind === 'like') return 'Review reaction'
    return 'Review post'
  }
  if (step === 'join') return 'Join Social to continue'
  if (step === 'username') return 'Choose a username'
  if (step === 'store') return 'Get Möbius · You'
  return 'Continue in Möbius · You'
}

// Navigation belongs to the shell. It resolves the installed numeric app id;
// when Identity is absent, the Store owns catalog resolution through its
// documented `app:<manifest-id>` intent rather than a guessed URL.
export function accountHandoff(profile, postMessage) {
  const installedId = profile?.identity_app_id
  const message = installedId == null
    ? { type: 'moebius:open-app', appId: 'store', intent: 'app:identity' }
    : { type: 'moebius:open-app', appId: installedId }
  postMessage(message, '*')
  return installedId == null ? 'store' : 'identity'
}
