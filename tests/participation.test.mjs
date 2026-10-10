import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { setToken, postReply } from '../api.js'
import { attachmentBytes, galleryFitsMediaLimits, GIF_MAX_BYTES, IMAGE_MAX_BYTES, THUMBNAIL_MAX_BYTES } from '../media_limits.js'
import { boardPostFitsWireLimit } from '../board_payload.js'
import { upsertReplyAttempt } from '../reconciliation.js'
import {
  PARTICIPATION_INTENT_PATH, accountHandoff, clearParticipationIntent,
  completedParticipationIntent, createParticipationIntent, loadParticipationIntent, participationActionLabel, participationStep,
  participationIntentMatches, saveParticipationIntent,
} from '../participation.js'

const originalFetch = globalThis.fetch
test.afterEach(() => { globalThis.fetch = originalFetch })

function memoryStorage() {
  const values = new Map()
  let version = 0
  return {
    values,
    async get(path) { return values.get(path) ?? null },
    async getWithVersion(path) { return { value: values.get(path) ?? null, version: version || null } },
    async durableWrite(path, value, opts) {
      if ((opts.ifNoneMatch && version) || (opts.ifMatch != null && opts.ifMatch !== version)) {
        throw Object.assign(new Error('Draft changed in another window'), { code: 'conflict' })
      }
      values.set(path, value)
      version++
    },
    async set(path, value) { values.set(path, value) },
    async remove(path) { values.delete(path) },
  }
}

function media(mime, bytes) {
  return { mime, data_b64: Buffer.alloc(bytes, 65).toString('base64'), w: 40, h: 30 }
}

// Execute the real resume/submit/clear handlers without a network publication
// or a copied implementation. The surrounding React state is fixture-owned.
function handler(source, name, async = false) {
  const start = source.indexOf(`  ${async ? 'async ' : ''}function ${name}(`)
  assert.notEqual(start, -1)
  return source.slice(start, source.indexOf('\n  }', start) + 4)
}

async function restoredBoard(saved, { fail = false, failPreparation = false } = {}) {
  const storage = memoryStorage()
  await storage.durableWrite(PARTICIPATION_INTENT_PATH, saved, { ifNoneMatch: true })
  const loaded = await loadParticipationIntent(storage)
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')
  const sent = [], completions = [], errors = []
  let failedSends = 0, failedPreparations = 0
  const env = {
    participationIntent: loaded, canInteract: true, feed: [{ id: saved.post_id }],
    draft: '', selectedImages: [], replyDraft: '', replyImage: null, replyPost: null,
    replyMessageId: 'reply-id', replySending: false, handoffBusy: false, preparingReplyImage: false,
    me: { host: 'test.invalid', handle: 'test' },
    window: { mobius: { storage } }, crypto: { randomUUID: () => 'reply-id' },
    galleryFitsMediaLimits, attachmentBytes, THUMBNAIL_MAX_BYTES,
    boardPostFitsWireLimit(values) {
      if (failPreparation && failedPreparations++ === 0) throw new Error('Preparation failed')
      return boardPostFitsWireLimit(values)
    },
    completedParticipationIntent, participationIntentMatches, clearParticipationIntent, loadParticipationIntent,
    upsertReplyAttempt, replySendingRef: { current: false }, replyPostIdRef: { current: null },
    replyDrafts: { current: new Map() }, replyCache: new Map(),
    setDraft: value => { env.draft = value }, setSelectedImages: value => { env.selectedImages = value },
    setReplyDraft: value => { env.replyDraft = value }, setReplyImage: value => { env.replyImage = value },
    setReplyMessageId: value => { env.replyMessageId = value },
    setParticipationIntent: value => { env.participationIntent = value },
    setComposing() {}, markActivity() {}, setPosting() {}, setPending() {}, setReplies() {}, onPostConfirmed: undefined,
    setReplySending() {}, rememberReplies() {}, onRefresh() {}, async loadReplies() {},
    showToast: message => errors.push(message),
    openReplies(post, { text, image }) {
      env.replyPost = post; env.replyDraft = text; env.replyImage = image
      env.replyPostIdRef.current = post.id
    },
    async prepareImage() { throw new Error('Restored original must not be recompressed') },
    async publishPost(text, attachment, attachments, thumbnails) {
      sent.push({ text, attachment, attachments, thumbnails })
      for (const thumb of thumbnails || []) assert.ok(attachmentBytes(thumb) <= THUMBNAIL_MAX_BYTES)
      if (fail && failedSends++ === 0) throw new Error('Publication failed')
      return { id: 'post-id' }
    },
    async postReply(postId, text, { attachment, thumbnail }) {
      sent.push({ postId, text, attachment, thumbnail })
      if (thumbnail) assert.ok(attachmentBytes(thumbnail) <= THUMBNAIL_MAX_BYTES)
      if (fail && failedSends++ === 0) throw new Error('Publication failed')
      return { id: 'reply-id' }
    },
  }
  const functions = [handler(board, 'resumeParticipation'), handler(board, 'collectImagePayloads', true),
    handler(board, 'publish', true), handler(board, 'sendReply', true),
    handler(app, 'completeParticipationIntent', true)].join('\n')
  const actions = new Function('env', `with (env) { ${functions}; return {
    resumeParticipation, publish, sendReply, completeParticipationIntent,
  } }`)(env)
  env.onCompleteParticipation = intent => { completions.push(actions.completeParticipationIntent(intent)) }
  actions.resumeParticipation()
  return { storage, env, sent, errors, actions, async submit() {
    if (saved.kind === 'post') await actions.publish()
    else await actions.sendReply({ preventDefault() {} })
    await Promise.all(completions)
  } }
}

test('restored originals without previews publish and clear the exact saved post', async () => {
  for (const originals of [[media('image/gif', 1024)], [media('image/jpeg', 1024), media('image/png', 1024)]]) {
    const saved = createParticipationIntent('post', { text: '  Saved caption  ',
      ...(originals.length === 1 ? { attachment: originals[0] } : { attachments: originals }) })
    const flow = await restoredBoard(saved)
    await flow.submit()
    assert.deepEqual(flow.errors, [])
    assert.equal(flow.sent.length, 1)
    assert.deepEqual(flow.sent[0].attachments || [flow.sent[0].attachment], originals)
    assert.equal(flow.sent[0].thumbnails, undefined)
    assert.equal(await loadParticipationIntent(flow.storage), null)
    assert.equal(createParticipationIntent('post', { attachment: originals[0], thumbnails: [] }).thumbnails, undefined)
    assert.equal(createParticipationIntent('post', { attachments: [] }), null)
  }
})

test('accepted legacy previews resume, publish originals without oversized renditions and clear', async () => {
  for (const kind of ['post', 'reply']) {
    const original = media('image/png', 1024), thumbnail = media('image/webp', 200_000)
    const saved = { version: 1, kind, text: 'Legacy caption', attachment: original,
      ...(kind === 'reply' ? { post_id: 'post-1', thumbnail } : { thumbnails: [thumbnail] }) }
    const flow = await restoredBoard(saved)
    assert.deepEqual(flow.env.participationIntent, saved)
    assert.equal(createParticipationIntent(kind, saved), null)
    assert.equal(await saveParticipationIntent(flow.storage, saved), false)
    await flow.submit()
    assert.deepEqual(flow.errors, [])
    assert.deepEqual(flow.sent[0].attachment, original)
    assert.equal(flow.sent[0].thumbnail, undefined)
    assert.equal(flow.sent[0].thumbnails, undefined)
    assert.equal(await loadParticipationIntent(flow.storage), null)
  }
})

test('failed restored publication keeps originals, caption and the durable draft', async () => {
  for (const kind of ['post', 'reply']) {
    const saved = createParticipationIntent(kind, { postId: 'post-1', text: 'Retry me', attachment: media('image/png', 100) })
    const flow = await restoredBoard(saved, { fail: true })
    await flow.submit()
    assert.deepEqual(await loadParticipationIntent(flow.storage), saved)
    assert.equal(kind === 'post' ? flow.env.draft : flow.env.replyDraft, saved.text)
    assert.deepEqual(kind === 'post' ? flow.env.selectedImages[0].payload : flow.env.replyImage.payload, saved.attachment)
    assert.deepEqual(flow.errors, ['Publication failed'])
  }
})

test('preparation and send failures preserve the exact restored caption through a successful retry', async () => {
  const saved = createParticipationIntent('post', {
    text: '  Keep spaces  ', attachment: media('image/png', 100),
  })
  for (const failure of [{ failPreparation: true }, { fail: true }]) {
    const flow = await restoredBoard(saved, failure)
    await flow.submit()
    assert.equal(flow.env.draft, saved.text)
    assert.deepEqual(await loadParticipationIntent(flow.storage), saved)
    assert.deepEqual(flow.env.selectedImages[0].payload, saved.attachment)
    await flow.submit()
    assert.equal(flow.sent.at(-1).text, saved.text.trim())
    assert.deepEqual(flow.sent.at(-1).attachment, saved.attachment)
    assert.equal(await loadParticipationIntent(flow.storage), null)
    assert.equal(flow.errors.length, 1)
  }
})

test('restored current-budget previews stay on the wire and changed legacy previews do not consume the draft', async () => {
  const attachment = media('image/png', 100)
  for (const bytes of [THUMBNAIL_MAX_BYTES, 200_000]) {
    const thumbnail = media('image/webp', bytes)
    const saved = { version: 1, kind: 'post', text: 'Keep exact', attachment, thumbnails: [thumbnail] }
    const flow = await restoredBoard(saved)
    if (bytes > THUMBNAIL_MAX_BYTES) flow.env.selectedImages[0].thumbnailPayload = media('image/webp', bytes - 1)
    await flow.submit()
    if (bytes <= THUMBNAIL_MAX_BYTES) {
      assert.deepEqual(flow.sent[0].thumbnails, [thumbnail])
      assert.equal(await loadParticipationIntent(flow.storage), null)
    } else {
      assert.equal(flow.sent[0].thumbnails, undefined)
      assert.deepEqual(await loadParticipationIntent(flow.storage), saved)
    }
  }
})

test('restored publication cannot clear changed content or a concurrent replacement draft', async () => {
  const saved = createParticipationIntent('post', { text: 'Original', attachment: media('image/png', 100) })
  for (const change of ['caption', 'image', 'storage']) {
    const flow = await restoredBoard(saved)
    let expected = saved
    if (change === 'caption') flow.env.draft = 'Changed'
    if (change === 'image') flow.env.selectedImages[0].payload = media('image/png', 101)
    if (change === 'storage') {
      expected = createParticipationIntent('post', { text: 'Another window' })
      await flow.storage.durableWrite(PARTICIPATION_INTENT_PATH, expected, { ifMatch: 1 })
    }
    await flow.submit()
    assert.deepEqual(await loadParticipationIntent(flow.storage), expected)
  }
})

test('a maximum-size GIF and caption survive account handoff, reload and exact matching', async () => {
  const storage = memoryStorage()
  const attachment = media('image/gif', GIF_MAX_BYTES)
  const draft = createParticipationIntent('reply', {
    postId: '12345678-abcd', text: 'Caption stays', attachment,
    thumbnail: media('image/webp', THUMBNAIL_MAX_BYTES),
  })
  assert.ok(draft)
  assert.equal(await saveParticipationIntent(storage, draft), true)
  accountHandoff({ identity_app_id: 42 }, () => {})
  const loaded = await loadParticipationIntent(storage)
  assert.deepEqual(loaded, draft)
  assert.equal(participationIntentMatches(loaded, draft), true)
  assert.equal(participationIntentMatches(loaded, {
    ...draft, attachment: media('image/gif', GIF_MAX_BYTES - 1),
  }), false)
  assert.equal(await clearParticipationIntent(storage, { ...draft, attachment: null }), false)
  assert.deepEqual(await loadParticipationIntent(storage), draft)
})

test('four maximum-size photos remain one exact gallery draft across save and load', async () => {
  const storage = memoryStorage()
  const photos = Array.from({ length: 4 }, () => media('image/jpeg', IMAGE_MAX_BYTES))
  const draft = createParticipationIntent('post', { text: 'Four photos', attachments: photos })
  assert.ok(draft)
  await saveParticipationIntent(storage, draft)
  assert.deepEqual(await loadParticipationIntent(storage), draft)
  assert.equal(participationIntentMatches(draft, { ...draft, attachments: photos.slice(0, 3) }), false)
})

test('oversize originals and thumbnails never collapse into matching text-only drafts', async () => {
  const storage = memoryStorage()
  const textOnly = createParticipationIntent('post', { text: 'Keep photo' })
  await saveParticipationIntent(storage, textOnly)
  const badPhoto = { ...textOnly, attachment: media('image/jpeg', IMAGE_MAX_BYTES + 1) }
  const badGif = { ...textOnly, attachment: media('image/gif', GIF_MAX_BYTES + 1) }
  const badThumbnail = { ...textOnly, attachment: media('image/jpeg', 100),
    thumbnails: [media('image/webp', THUMBNAIL_MAX_BYTES + 1)] }
  for (const invalid of [badPhoto, badGif, badThumbnail]) {
    assert.equal(createParticipationIntent('post', invalid), null)
    assert.equal(participationIntentMatches(invalid, textOnly), false)
    assert.equal(await saveParticipationIntent(storage, invalid), false)
  }
  assert.deepEqual(await loadParticipationIntent(storage), textOnly)
})

test('legacy saved thumbnail stays loadable while new oversized thumbnails are refused', async () => {
  const storage = memoryStorage()
  const old = { version: 1, kind: 'reply', post_id: '12345678-abcd', text: 'Old draft',
    attachment: media('image/png', 100), thumbnail: media('image/webp', 200_000) }
  await storage.set(PARTICIPATION_INTENT_PATH, old)
  assert.deepEqual(await loadParticipationIntent(storage), old)
  assert.equal(createParticipationIntent('reply', {
    postId: old.post_id, text: old.text, attachment: old.attachment, thumbnail: old.thumbnail,
  }), null)
})

test('concurrent large drafts preserve the CAS winner without losing media', async () => {
  const storage = memoryStorage()
  const first = createParticipationIntent('post', {
    text: 'First', attachment: media('image/gif', GIF_MAX_BYTES),
  })
  const second = createParticipationIntent('reply', {
    postId: '12345678-abcd', text: 'Second', attachment: media('image/jpeg', IMAGE_MAX_BYTES),
  })
  const outcomes = await Promise.allSettled([
    saveParticipationIntent(storage, first), saveParticipationIntent(storage, second),
  ])
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1)
  assert.deepEqual(await loadParticipationIntent(storage), first)
  assert.equal(await clearParticipationIntent(storage, second), false)
})

test('a post draft and attachment survive an account handoff without being submitted', async () => {
  const storage = memoryStorage()
  const attachment = {
    mime: 'image/jpeg', data_b64: 'cGhvdG8=', w: 640, h: 480,
  }
  const intent = createParticipationIntent('post', {
    text: 'Still mine until I press Post', attachment,
  })
  assert.equal(await saveParticipationIntent(storage, intent), true)

  const messages = []
  accountHandoff({ identity_app_id: 42 }, (...args) => messages.push(args))

  assert.deepEqual(await loadParticipationIntent(storage), intent)
  assert.deepEqual(messages, [[{ type: 'moebius:open-app', appId: 42 }, '*']])
  assert.equal(storage.values.has(PARTICIPATION_INTENT_PATH), true)
})

test('cancelled or incomplete sign-in leaves the exact reply draft waiting', async () => {
  const storage = memoryStorage()
  const intent = createParticipationIntent('reply', {
    postId: '12345678-abcd', text: 'I will decide when to send this',
  })
  await saveParticipationIntent(storage, intent)
  assert.deepEqual(await loadParticipationIntent(storage), intent)
})

test('a combined reply photo and caption survive an account handoff as one draft', async () => {
  const storage = memoryStorage()
  const attachment = { mime: 'image/png', data_b64: 'cGhvdG8=', w: 40, h: 30 }
  const thumbnail = { mime: 'image/webp', data_b64: 'dGh1bWI=', w: 40, h: 30 }
  const intent = createParticipationIntent('reply', {
    postId: '12345678-abcd', text: 'Caption stays with its photo', attachment, thumbnail,
  })
  await saveParticipationIntent(storage, intent)
  assert.deepEqual(await loadParticipationIntent(storage), intent)
  assert.deepEqual(intent.attachment, attachment)
  assert.deepEqual(intent.thumbnail, thumbnail)
})

test('a missing Identity installation opens its exact Store listing', () => {
  const messages = []
  assert.equal(accountHandoff({}, (...args) => messages.push(args)), 'store')
  assert.deepEqual(messages, [[{
    type: 'moebius:open-app', appId: 'store', intent: 'app:identity',
  }, '*']])
})

test('participation keeps account linking, directory consent and final action separate', () => {
  assert.equal(participationStep({ connected: false, joined: false }), 'store')
  assert.equal(participationStep({ connected: false, joined: false, identity_app_id: 8 }), 'identity')
  assert.equal(participationStep({ connected: true, joined: false, name: 'Ada', handle: 'ada' }), 'join')
  assert.equal(participationStep({
    connected: true, joined: true, name: 'Ada', handle: 'ada',
  }), 'ready')
})

test('a linked account without a username chooses one before taking part', () => {
  const unnamed = { connected: true, name: 'Ada', handle: '', identity_app_id: 8 }
  assert.equal(participationStep({ ...unnamed, joined: false }), 'username')
  // Members who joined before usernames were required are asked too.
  assert.equal(participationStep({ ...unnamed, joined: true }), 'username')
  assert.equal(participationActionLabel('username'), 'Choose a username')
})

test('only explicit completion clears a pending action', async () => {
  const storage = memoryStorage()
  await saveParticipationIntent(storage, createParticipationIntent('like', { postId: '12345678' }))
  assert.ok(await loadParticipationIntent(storage))
  assert.equal(await clearParticipationIntent(storage, await loadParticipationIntent(storage)), true)
  assert.equal(await loadParticipationIntent(storage), null)
})

test('posting a different draft cannot consume the preserved one', () => {
  const pending = createParticipationIntent('post', { text: 'Keep this' })
  assert.equal(participationIntentMatches(
    pending, createParticipationIntent('post', { text: 'Something else' }),
  ), false)
  assert.equal(participationIntentMatches(
    pending, createParticipationIntent('post', { text: 'Keep this' }),
  ), true)
})

test('a tap before the profile loads is never saved as a sign-up draft', () => {
  const source = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('async function continueParticipation'))
  assert.ok(body.indexOf('if (!me)') < body.indexOf('onRequestParticipation(intent)'))
})

test('public Community renders before Join while Chats and People show only access gates', () => {
  const source = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')
  assert.match(source, /loadFeed\(\)\s*loadMe\(\)/)
  assert.doesNotMatch(source, /loadMe\(\)\.then/)
  assert.match(source, /\{tab === 'board' && \(/)
  assert.match(source, /\{tab === 'people' && \(/)
  assert.match(source, /canParticipate \? <People/)
  assert.match(source, /<JoinAccess area="People"/)
  assert.match(source, /<JoinAccess area="Chats"/)
  assert.match(source, /if \(hasPrivateAccess\) loadConversations\(\)/)
  assert.match(source, /conversationLoad\.current \+= 1/)
  assert.match(source, /me\?\.registration !== 'missing'/)
  assert.doesNotMatch(source, /tab === 'board' && !needsJoin/)
  assert.doesNotMatch(source, /tab === 'people' && !needsJoin/)
})

test('board replies use the owner route that signs and forwards remote replies', async () => {
  setToken('social-app-token')
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/services/social/reply')
    assert.equal(options.method, 'POST')
    assert.equal(options.headers.Authorization, 'Bearer social-app-token')
    assert.deepEqual(JSON.parse(options.body), { post_id: '12345678', text: 'Hello' })
    return Response.json({ status: 'ok' })
  }
  assert.deepEqual(await postReply('12345678', 'Hello'), { status: 'ok' })
})

test('the UI keeps a final explicit control for publish, reply and react', () => {
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  assert.match(board, /async function submitPost/)
  assert.match(board, /if \(canInteract\) await publish\(\)/)
  assert.match(board, /<Composer className="cn-board-composer" onSubmit=\{submitPost\}/)
  const composer = readFileSync(new URL('../ui/Composer.jsx', import.meta.url), 'utf8')
  assert.match(composer, /className="cn-composer-send" type="submit"/)
  assert.match(board, /<Composer className="cn-reply-composer" onSubmit=\{sendReply\}/)
  assert.match(board, /toggleReaction\(post, emoji\)/)
  assert.match(board, /cn-inline-thread/)
  assert.match(board, /Nothing was shared automatically/)
})

test('saved reactions preserve the chosen standard emoji for explicit review', () => {
  assert.deepEqual(createParticipationIntent('like', {
    postId: '12345678', emoji: '🎉',
  }), { version: 1, kind: 'like', post_id: '12345678', emoji: '🎉' })
  assert.equal(createParticipationIntent('like', {
    postId: '12345678', emoji: 'not-standard',
  }).emoji, '❤️')
})


test('a Like cannot overwrite an existing photo post draft', async () => {
  const storage = memoryStorage()
  const post = createParticipationIntent('post', { text: 'Keep this photo',
    attachment: { mime: 'image/png', data_b64: 'cGhvdG8=', w: 12, h: 12 } })
  await saveParticipationIntent(storage, post)
  await assert.rejects(saveParticipationIntent(storage,
    createParticipationIntent('like', { postId: 'different-post' })), /already have a saved action/)
  assert.deepEqual(await loadParticipationIntent(storage), post)
})

test('concurrent first saves keep exactly one complete draft', async () => {
  const storage = memoryStorage()
  const post = createParticipationIntent('post', { text: 'First window' })
  const reply = createParticipationIntent('reply', { postId: 'post-1', text: 'Second window' })
  const results = await Promise.allSettled([
    saveParticipationIntent(storage, post), saveParticipationIntent(storage, reply),
  ])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.deepEqual(await loadParticipationIntent(storage), post)
})

test('stale completion cannot erase a different saved intent', async () => {
  const storage = memoryStorage()
  const old = createParticipationIntent('like', { postId: 'old-post' })
  const next = createParticipationIntent('post', { text: 'New window draft' })
  await saveParticipationIntent(storage, next)
  assert.equal(await clearParticipationIntent(storage, old), false)
  assert.deepEqual(await loadParticipationIntent(storage), next)
})

test('completing a different emoji cannot erase a saved reaction', async () => {
  const storage = memoryStorage()
  const saved = createParticipationIntent('like', { postId: 'same-post', emoji: '🎉' })
  const completed = createParticipationIntent('like', { postId: 'same-post', emoji: '❤️' })
  await saveParticipationIntent(storage, saved)

  assert.equal(await clearParticipationIntent(storage, completed), false)
  assert.deepEqual(await loadParticipationIntent(storage), saved)
  assert.equal(await clearParticipationIntent(storage, saved), true)
})

test('repeating the same saved draft is idempotent', async () => {
  const storage = memoryStorage()
  const post = createParticipationIntent('post', { text: 'Keep' })
  await saveParticipationIntent(storage, post)
  await saveParticipationIntent(storage, post)
  assert.equal((await storage.getWithVersion(PARTICIPATION_INTENT_PATH)).version, 1)
})
