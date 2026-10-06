import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { reachedEarlierHistory } from '../ui/historyScroll.js'
import { prependedScrollTop } from '../ui/interactionRules.js'

function owningFunction(file, start, end, deps) {
  const source = readFileSync(new URL(`../ui/${file}`, import.meta.url), 'utf8')
  const a = source.indexOf(start)
  const b = source.indexOf(end, a)
  assert.ok(a >= 0 && b > a, `${file}: owning function exists`)
  // Execute the actual component function body with its hook values mocked;
  // no alternate pagination implementation is introduced by these tests.
  return Function('deps', `with (deps) { return (${source.slice(a, b).trim()}) }`)(deps)
}

test('near-top means an upward user scroll, never initial position or prepend anchoring', () => {
  const el = { scrollTop: 0, scrollHeight: 1000, clientHeight: 300 }
  assert.equal(reachedEarlierHistory(null, el), false)
  assert.equal(reachedEarlierHistory(0, el), false)
  el.scrollTop = 40
  assert.equal(reachedEarlierHistory(200, el), true)
  assert.equal(reachedEarlierHistory(20, el), false)
  el.scrollHeight = el.clientHeight
  assert.equal(reachedEarlierHistory(200, el), false)
})

for (const [file, listName, identity] of [
  ['Thread.jsx', 'listMessages', 'peer'],
  ['GroupThread.jsx', 'listGroupMessages', 'gid'],
]) {
  test(`${file} owns near-top pagination, dedupe, retry and anchored prepend`, async () => {
    const el = { scrollTop: 200, scrollHeight: 1000, clientHeight: 300 }
    const frames = []
    const calls = []
    let resolve, reject
    const deps = {
      nextCursor: 'first', loadingEarlier: false, earlierInFlight: { current: false },
      earlierFailed: { current: false }, lastScrollTop: { current: 200 },
      paginationGeneration: { current: 1 }, conversationEpoch: { current: 1 },
      scrollRef: { current: el }, stickToBottom: { current: true },
      reachedEarlierHistory, requestPending: false, currentGroup: { request_status: 'accepted' },
      requestStatus: () => 'accepted',
      [identity]: 'conversation-1',
      [listName]: (...args) => { calls.push(args); return new Promise((yes, no) => { resolve = yes; reject = no }) },
      reconcileOlderPage: (_prior, page) => page,
      messagesRef: { current: [{ id: 'latest' }] },
      updateMessages: rows => { deps.messagesRef.current = rows; el.scrollHeight += 100 },
      setNextCursor: cursor => { deps.nextCursor = cursor },
      setLoadingEarlier: value => { deps.loadingEarlier = value },
      setLoadError: value => { deps.loadError = value },
      requestAnimationFrame: callback => frames.push(callback),
    }
    const load = owningFunction(file, 'async function loadEarlier() {', file === 'Thread.jsx' ? 'async function decideRequest' : 'useEffect(() => {\n    const el = scrollRef.current', deps)
    deps.loadEarlier = load
    const track = owningFunction(file, 'function trackScroll() {', 'async function chooseImage', deps)

    el.scrollTop = 40
    track()
    assert.equal(calls.length, 1)
    assert.equal(calls[0][1], 'first')
    el.scrollTop = 30
    track()
    assert.equal(calls.length, 1, 'one page request in flight')
    resolve({ messages: [{ id: 'older' }], nextCursor: null })
    await new Promise(setImmediate)
    frames.shift()()
    assert.equal(el.scrollTop, 130, 'prepend keeps the visible message in place')
    assert.equal(deps.nextCursor, null)
    el.scrollTop = 20
    track()
    assert.equal(calls.length, 1, 'no cursor means no more requests')

    deps.nextCursor = 'retry'
    el.scrollTop = 150
    track()
    el.scrollTop = 25
    track()
    assert.equal(calls.length, 2)
    reject(new Error('offline'))
    await new Promise(setImmediate)
    assert.match(deps.loadError, /Earlier messages couldn’t be loaded/)
    el.scrollTop = 20
    track()
    assert.equal(calls.length, 2, 'failure stays visible rather than auto-retrying')
    const retry = load()
    assert.equal(calls.length, 3, 'explicit retry is possible')
    resolve({ messages: [{ id: 'oldest' }], nextCursor: null })
    await retry
    assert.equal(deps.loadError, '')
  })
}

test('Community owner only triggers on upward near-top scroll and preserves prepend offset', async () => {
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  assert.match(board, /reachedEarlierHistory\(lastScrollTop\.current, scroller\)/)
  assert.match(board, /shouldLoad && feedState === 'ready' && hasEarlier && !earlierFailed\.current/)
  assert.match(board, /earlierInFlight\.current = true/)
  assert.match(board, /earlierFailed\.current = true/)
  assert.match(board, /onClick=\{loadEarlierPosts\}>Try again/)
  const el = { scrollTop: 24, scrollHeight: 1000, clientHeight: 300 }
  let resolve
  const deps = {
    feed: [{ created_at: 12 }], hasEarlier: true,
    earlierInFlight: { current: false }, earlierFailed: { current: false },
    scrollRef: { current: el },
    setLoadingEarlier: value => { deps.loadingEarlier = value },
    setEarlierError: value => { deps.error = value },
    onLoadEarlier: () => new Promise(yes => { resolve = yes }),
    requestAnimationFrame: callback => { deps.frame = callback },
    prependedScrollTop,
  }
  const load = owningFunction('Board.jsx', 'async function loadEarlierPosts() {', 'function markActivity', deps)
  const first = load()
  load()
  assert.equal(deps.loadingEarlier, true)
  assert.equal(deps.earlierInFlight.current, true)
  el.scrollHeight = 1150
  resolve()
  await first
  deps.frame()
  assert.equal(el.scrollTop, 174)
  assert.equal(deps.earlierInFlight.current, false)
  deps.onLoadEarlier = () => Promise.reject(new Error('offline'))
  await load()
  assert.match(deps.error, /Earlier posts couldn’t be loaded/)
  assert.equal(deps.earlierFailed.current, true)
  deps.onLoadEarlier = () => Promise.resolve()
  await load() // the visible Try again button calls this owner function
  assert.equal(deps.error, '')
  deps.hasEarlier = false
  deps.onLoadEarlier = () => { throw new Error('must not fetch') }
  await load()
})
