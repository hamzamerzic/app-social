import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { createParticipationIntent } from '../participation.js'
import { reconcileReplies } from '../reconciliation.js'

const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')

// Exercise the actual cache and event handlers without React or live federation.
function section(start, end) {
  const first = board.indexOf(start)
  const last = board.indexOf(end, first)
  assert.ok(first >= 0 && last > first, `Missing Board handler: ${start}`)
  return board.slice(first, last)
}

const handlers = [
  section('const profileCache =', 'function Avatar('),
  section('  async function loadReplies(', '  function openReplies('),
  section('  async function sendReply(', '  const { overrides: reactionOverrides'),
].join('\n')

const reply = (id, text = id) => ({
  id, text, host: 'member.example', handle: 'member', created_at: 1,
})

function thread({ count = 0, read, send } = {}) {
  const post = { id: 'test-post', reply_count: count }
  let rows = []
  let serverRows = []
  let reads = 0
  let state = 'idle'
  const errors = []
  const context = vm.createContext({
    Date, Map, Set, String, Number, Promise,
    createParticipationIntent, reconcileReplies,
    replyRequest: { current: 0 }, replySendingRef: { current: false },
    replyPost: post, replyDraft: 'My reply', replySending: false,
    canInteract: true, handoffBusy: false,
    me: { host: 'member.example', handle: 'member' },
    window: { mobius: { signal() {} } },
    markActivity() {}, onCompleteParticipation() {}, async onRefresh() {},
    showToast(message) { errors.push(message) },
    setReplies(value) { rows = typeof value === 'function' ? value(rows) : value },
    setReplyState(value) { state = value }, setReplyError() {},
    setReplyDraft(value) { context.replyDraft = value },
    setReplySending(value) { context.replySending = value },
    async getReplies() {
      reads += 1
      return read ? read(reads) : { replies: serverRows }
    },
    async postReply() {
      if (send) return send()
      const landed = reply('confirmed', context.replyDraft || 'My reply')
      serverRows = [...serverRows, landed]
      return { id: landed.id, reply_count: serverRows.length }
    },
  })
  vm.runInContext(handlers, context)
  return {
    post, context, errors,
    get ids() { return Array.from(rows, row => row.id) },
    get reads() { return reads }, get state() { return state },
    set serverRows(value) { serverRows = value },
    set rows(value) { rows = value },
    load(options) { return context.loadReplies(post, options) },
    send() { return context.sendReply({ preventDefault() {} }) },
  }
}

test('initially empty threads still open immediately without a network read', async () => {
  const view = thread()
  await view.load()
  assert.equal(view.reads, 0)
  assert.equal(view.state, 'ready')
  assert.deepEqual(view.ids, [])
})

test('a confirmed first reply survives successive polls with the original zero feed count', async () => {
  const view = thread()
  await view.load()
  await view.send()
  assert.deepEqual(view.ids, ['confirmed'])
  await view.load({ background: true })
  await view.load({ background: true })
  assert.deepEqual(view.ids, ['confirmed'])
  assert.equal(view.reads, 3)
  assert.equal(view.post.reply_count, 0, 'the feed count is only an opening hint')
})

test('reopening before the feed catches up retains a cached confirmed reply', async () => {
  const view = thread()
  await view.load()
  await view.send()
  await view.load()
  assert.deepEqual(view.ids, ['confirmed'])
})

test('a sent first reply survives reopening when its confirmation read fails', async () => {
  const view = thread({ read: () => { throw new Error('Offline') } })
  await view.load()
  await view.send()
  assert.deepEqual(view.ids, ['confirmed'])
  assert.equal(view.context.replyDraft, '')
  assert.deepEqual(view.errors, [], 'a failed read must not turn a successful write into a failed send')
  view.rows = []
  await view.load()
  assert.deepEqual(view.ids, ['confirmed'], 'reopening must retain the successful write despite the stale zero count')
  assert.equal(await view.load({ background: true }), false)
  assert.deepEqual(view.ids, ['confirmed'])
})

test('failed confirmation retains earlier replies, while a later canonical read can remove them', async () => {
  const view = thread({ count: 1, read: (number) => {
    if (number === 1) return { replies: [reply('earlier')] }
    if (number === 2) throw new Error('Offline')
    return { replies: [] }
  } })
  await view.load()
  await view.send()
  view.rows = []
  await view.load()
  assert.deepEqual(view.ids, ['earlier', 'confirmed'])
  await view.load({ background: true })
  assert.deepEqual(view.ids, [], 'successful snapshots remain authoritative, including deletion')
})

test('an open empty thread discovers a peer reply without waiting for cache expiry', async () => {
  const view = thread()
  await view.load()
  view.serverRows = [reply('peer-reply')]
  await view.load({ background: true })
  assert.deepEqual(view.ids, ['peer-reply'])
  assert.equal(view.reads, 1)
})

test('background checks revalidate a recently cached nonempty thread and preserve a draft', async () => {
  const view = thread({ count: 1 })
  view.serverRows = [reply('first')]
  await view.load()
  view.context.replyDraft = 'Unsent draft'
  view.serverRows = [reply('first'), reply('second')]
  await view.load({ background: true })
  assert.deepEqual(view.ids, ['first', 'second'])
  assert.equal(view.context.replyDraft, 'Unsent draft')
  assert.equal(view.reads, 2)
})

test('confirmation does not reuse a thread read started before the reply was sent', async () => {
  let releaseStale
  const view = thread({ count: 1, read: (number) => number === 1
    ? new Promise(resolve => { releaseStale = resolve })
    : { replies: [reply('confirmed')] } })
  const stale = view.load({ background: true })
  const sending = view.send()
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve()
  try {
    assert.equal(view.reads, 2, 'confirmation must start a post-write read')
  } finally {
    releaseStale({ replies: [] })
    await Promise.all([stale, sending])
  }
  assert.deepEqual(view.ids, ['confirmed'])
  await view.load()
  assert.deepEqual(view.ids, ['confirmed'], 'late pre-write response cannot overwrite the cache')
})

test('a failed background read keeps replies and the unsent draft intact', async () => {
  const view = thread({ count: 1, read: (number) => {
    if (number > 1) throw new Error('Offline')
    return { replies: [reply('confirmed')] }
  } })
  await view.load()
  view.context.replyDraft = 'Unsent draft'
  assert.equal(await view.load({ background: true }), false)
  assert.deepEqual(view.ids, ['confirmed'])
  assert.equal(view.context.replyDraft, 'Unsent draft')
  assert.equal(view.state, 'ready')
  assert.deepEqual(view.errors, [])
})

test('a failed send removes only its optimistic row and restores the reply draft', async () => {
  const view = thread({ count: 1, send: () => { throw new Error('Reply could not be sent') } })
  view.serverRows = [reply('earlier')]
  await view.load()
  await view.send()
  assert.deepEqual(view.ids, ['earlier'])
  assert.equal(view.context.replyDraft, 'My reply')
  assert.equal(view.context.replySending, false)
  assert.deepEqual(view.errors, ['Reply could not be sent'])
})
