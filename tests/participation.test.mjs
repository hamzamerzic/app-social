import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { setToken, postReply } from '../api.js'
import { GIF_MAX_BYTES, IMAGE_MAX_BYTES, THUMBNAIL_MAX_BYTES } from '../media_limits.js'
import {
  PARTICIPATION_INTENT_PATH, accountHandoff, clearParticipationIntent,
  createParticipationIntent, loadParticipationIntent, participationActionLabel, participationStep,
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
