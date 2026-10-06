import test from 'node:test'
import assert from 'node:assert/strict'

import { THUMBNAIL_LIMIT, boardThumbnail } from '../boardMediaCache.js'

// Social's sandboxed frame gets a fresh HTTP cache every launch, so saved
// thumbnails in app storage are what make a reopened board paint at once.
function storage(initial = {}) {
  const values = new Map(Object.entries(initial))
  const removed = []
  return {
    values,
    removed,
    async getBlob(path) { return values.get(path) || null },
    async setBlob(path, blob) { values.set(path, blob) },
    async get(path) { return values.get(path) || null },
    async set(path, value) { values.set(path, value) },
    async remove(path) { values.delete(path); removed.push(path) },
  }
}

test('a saved thumbnail paints without asking the service', async () => {
  const saved = new Blob(['saved'])
  globalThis.window = { mobius: { storage: storage({
    'cache/board-thumbnails/post-1-0.webp': saved,
    'cache/board-thumbnails/index.json': { paths: ['cache/board-thumbnails/post-1-0.webp'] },
  }) } }
  globalThis.fetch = async () => assert.fail('the saved thumbnail must be used')
  try {
    assert.equal(await boardThumbnail('post-1', 0), saved)
  } finally {
    delete globalThis.window
    delete globalThis.fetch
  }
})

test('an unsaved thumbnail goes straight to the service without a storage miss', async () => {
  const store = storage()
  store.getBlob = async () => assert.fail('a thumbnail missing from the index is not read')
  globalThis.window = { mobius: { storage: store } }
  globalThis.fetch = async () => ({ ok: true, async blob() { return new Blob(['fresh']) } })
  try {
    assert.equal(await (await boardThumbnail('post-new', 0)).text(), 'fresh')
  } finally {
    delete globalThis.window
    delete globalThis.fetch
  }
})

test('reply thumbnails use their parent-scoped route and cannot reuse a post thumbnail', async () => {
  const store = storage({
    'cache/board-thumbnails/post-1-0.webp': new Blob(['post photo']),
    'cache/board-thumbnails/index.json': { paths: ['cache/board-thumbnails/post-1-0.webp'] },
  })
  globalThis.window = { mobius: { storage: store } }
  let requested
  globalThis.fetch = async (path) => {
    requested = path
    return { ok: true, async blob() { return new Blob(['reply photo']) } }
  }
  try {
    assert.equal(await (await boardThumbnail('post-1', undefined, 'reply-1')).text(), 'reply photo')
    assert.match(requested, /reply-media\/post-1\/reply-1\?thumbnail=true$/)
    await new Promise(resolve => setTimeout(resolve, 1100))
    const { paths } = store.values.get('cache/board-thumbnails/index.json')
    assert.ok(paths.includes('cache/board-thumbnails/reply-post-1-reply-1.webp'))
    assert.ok(paths.includes('cache/board-thumbnails/post-1-0.webp'))
  } finally {
    delete globalThis.window
    delete globalThis.fetch
  }
})

test('new thumbnails are saved once and only the newest are kept', async () => {
  const store = storage()
  let requests = 0
  globalThis.window = { mobius: { storage: store } }
  globalThis.fetch = async () => {
    requests += 1
    return { ok: true, async blob() { return new Blob([`thumb-${requests}`]) } }
  }
  try {
    for (let post = 0; post <= THUMBNAIL_LIMIT; post += 1) {
      await boardThumbnail(`post-${post}`)
    }
    await boardThumbnail('post-5')
    // The index is written back once, after a short quiet period.
    await new Promise(resolve => setTimeout(resolve, 1100))
  } finally {
    delete globalThis.window
    delete globalThis.fetch
  }
  assert.equal(requests, THUMBNAIL_LIMIT + 1)
  const { paths } = store.values.get('cache/board-thumbnails/index.json')
  assert.equal(paths.length, THUMBNAIL_LIMIT)
  assert.deepEqual(store.removed, ['cache/board-thumbnails/post-0-0.webp'])
  assert.ok(!paths.includes('cache/board-thumbnails/post-0-0.webp'))
})
