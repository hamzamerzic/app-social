import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { searchPeople, getPeer } from '../api.js'

for (const [name, request] of [['people search', signal => searchPeople('a b', signal)], ['profile', signal => getPeer('example.test', signal)]]) {
  test(`${name} passes cancellation through to the network`, async () => {
    const original = globalThis.fetch
    const controller = new AbortController()
    let received
    globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
      received = options.signal
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    })
    try {
      const response = request(controller.signal)
      controller.abort()
      await assert.rejects(response, { name: 'AbortError' })
      assert.equal(received, controller.signal)
    } finally { globalThis.fetch = original }
  })
}

test('closing a profile invalidates its request instead of allowing it to reopen', () => {
  const source = readFileSync(new URL('../ui/People.jsx', import.meta.url), 'utf8')
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  assert.match(source, /const closeProfile = \(\) => \{[\s\S]*restoreProfileFocus\.current = true[\s\S]*setSelectedHost\(null\)/)
  // Profile fetching lives in the shared useProfile hook. Closing sets
  // selectedHost to null, which changes the hook key and runs its cleanup, so an
  // in-flight result cannot reopen the sheet. (A shared in-flight request can't
  // be per-consumer-aborted, so an active flag guards the stale apply.)
  assert.match(source, /useProfile\(selectedHost,/)
  assert.match(board, /function useProfile\(/)
  assert.match(board, /let active = true[\s\S]*?return \(\) => \{ active = false \}/)
  assert.match(source, /\{selectedHost && \(/)
})

test('Social modal focus owns initial focus so it can restore the actual opener', () => {
  for (const file of ['Board.jsx', 'People.jsx', 'Messages.jsx', 'Media.jsx']) {
    const source = readFileSync(new URL(`../ui/${file}`, import.meta.url), 'utf8')
    assert.match(source, /useModalFocus/)
    assert.doesNotMatch(source, /autoFocus/)
  }
  const focus = readFileSync(new URL('../ui/modalFocus.js', import.meta.url), 'utf8')
  assert.match(focus, /event\.key === 'Escape'/)
  assert.match(focus, /opener\.isConnected !== false/)
})

test('conversation recovery is visible and new messages do not steal the reading position', () => {
  for (const file of ['Thread.jsx', 'GroupThread.jsx']) {
    const source = readFileSync(new URL(`../ui/${file}`, import.meta.url), 'utf8')
    assert.match(source, /Messages couldn’t be refreshed/)
    assert.match(source, /onClick=\{refresh\}>Try again/)
    assert.match(source, /stickToBottom/)
    assert.match(source, /scrollHeight - el\.scrollTop - el\.clientHeight < 72/)
    assert.match(source, /paginationGeneration\.current \+= 1/)
    assert.match(source, /reconcileOlderPage/)
    assert.match(source, /generation === paginationGeneration\.current/)
    assert.match(source, /Loading messages…/)
    assert.match(source, /watchLatest(?:Group)?Messages/)
  }
})

test('message text stays selectable and reply uses an explicit touch target', () => {
  const bubble = readFileSync(new URL('../ui/MessageBubble.jsx', import.meta.url), 'utf8')
  const theme = readFileSync(new URL('../theme.js', import.meta.url), 'utf8')
  assert.doesNotMatch(bubble, /useReplyLongPress|onContextMenu|onPointerDown/)
  assert.match(bubble, /className="cn-bubble-reply"/)
  assert.match(theme, /\.cn-bubble-copy[\s\S]*user-select: text/)
  assert.match(theme, /@media \(hover: none\)[\s\S]*\.cn-bubble-reply \{ opacity: 1; pointer-events: auto; \}/)
  assert.doesNotMatch(theme, /\.cn-bubble-reply \{ display: none; \}/)
  assert.match(theme, /\.cn-board-send svg, \.cn-reply-send svg \{ width: 24px; height: 24px; \}/)
  assert.match(theme, /\.cn-board-send svg path, \.cn-reply-send svg path \{[\s\S]*stroke-width: \.24;/)
})

test('all message composers use touch-aware Enter behavior', () => {
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const input = readFileSync(new URL('../ui/MessageInput.jsx', import.meta.url), 'utf8')
  assert.match(input, /shouldSubmitMessageKey\(event, isTouchPrimary\(\)\)/)
  assert.match(input, /event\.currentTarget\.form\.requestSubmit\(\)/)
  assert.doesNotMatch(input, /pointer: coarse/)
  assert.equal((board.match(/<MessageInput /g) || []).length, 2)
  assert.match(board, /<MessageInput inputRef=\{replyInputRef\} className="cn-reply-input"/)
})

test('Community replaces the unjoined composer with Join and preserves earlier-message position', () => {
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  assert.match(board, /\{canInteract \? <form className="cn-board-composer" onSubmit=\{submitPost\}>/)
  assert.match(board, /cn-board-composer cn-board-join/)
  assert.match(board, /Join Social to message/)
  assert.match(board, /onOpen=\{togglePreview\}/)
  assert.match(board, /onClick=\{togglePreview\} disabled=\{!canInteract\}/)
  assert.match(board, /canInteract && me\?\.host && post\.host === me\.host/)
  assert.match(board, /\.cn-avatar'\)\) openReplies\(post\)/)
  assert.doesNotMatch(board, /Continue to send message/)
  assert.match(board, /const previousHeight = scroller\?\.scrollHeight/)
  assert.match(board, /prependedScrollTop\(previousTop, previousHeight, scroller\.scrollHeight\)/)
})

test('Community and replies use the Möbius chat composer primitive', () => {
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const theme = readFileSync(new URL('../theme.js', import.meta.url), 'utf8')
  assert.match(board, /className="cn-social-input-row"/)
  assert.match(board, /className=\{`cn-social-pill\$\{selectedImages\.length \? ' is-with-attachments' : ''\}`\}/)
  assert.equal((board.match(/className="cn-social-input-line"/g) || []).length, 2)
  assert.match(theme, /\.cn-social-pill \{[\s\S]*min-height: 48px;[\s\S]*border-radius: 24px;/)
  assert.match(theme, /\.cn-social-pill:focus-within \{[\s\S]*box-shadow: 0 0 0 3px var\(--accent-dim\);/)
  assert.match(theme, /\.cn-board-send, \.cn-reply-send \{[\s\S]*width: 40px; height: 40px;/)
  assert.match(theme, /\.cn-compose-image \{[\s\S]*width: 48px; height: 48px;/)
})

test('Community success actions stay quiet and image previews expose real zoom controls', () => {
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const media = readFileSync(new URL('../ui/Media.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(board, /Message sent|Post deleted/)
  assert.match(media, /className="cn-lightbox-controls"/)
  assert.match(media, /if \(event\.target === event\.currentTarget\) onClose\(\)/)
  assert.match(media, /aria-label="Zoom out"/)
  assert.match(media, /aria-label="Reset zoom"/)
  assert.match(media, /aria-label="Zoom in"/)
  assert.match(media, /onWheel=\{zoomWithWheel\}/)
  assert.match(media, /onPointerMove=\{moveImage\}/)
  assert.match(media, /setPointerCapture\?\.\(event\.pointerId\)/)
  assert.match(media, /onPointerUp=\{endImageMove\}/)
  assert.match(media, /onPointerCancel=\{endImageMove\}/)
  assert.match(media, /event\.key === '\+' \|\| event\.key === '='/)
  assert.match(media, /event\.key === '0'/)
})

test('message tabs keep one position and startup identity never flashes a label', () => {
  const messages = readFileSync(new URL('../ui/Messages.jsx', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')
  assert.ok(messages.indexOf('className="cn-message-tabs"') < messages.indexOf('className="cn-view-actions"'))
  assert.match(messages, /<h2>Chats<\/h2><p>Your accepted conversations and requests\.<\/p>/)
  assert.doesNotMatch(messages, /showingRequests \? 'Message requests'/)
  assert.doesNotMatch(app, /Browsing/)
  assert.match(app, /meState === 'loading'[\s\S]*cn-header-chip is-loading/)
})

test('direct messages keep one client identity and expose interrupted delivery retry', () => {
  const thread = readFileSync(new URL('../ui/Thread.jsx', import.meta.url), 'utf8')
  const api = readFileSync(new URL('../api.js', import.meta.url), 'utf8')
  assert.match(thread, /const messageId = crypto\.randomUUID\(\)/)
  assert.match(thread, /sendMessage\(messageId, peer/)
  assert.match(thread, /Delivery interrupted · Retry/)
  assert.match(thread, /retryMessage\(peer, messageId\)/)
  assert.match(api, /id,\s*\n\s*to,/)
  assert.match(api, /messages\/\$\{encodeURIComponent\(id\)\}\/retry/)
})

test('public board startup is not gated by identity and behaves like a chronological community chat', () => {
  const app = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(app, /if \(meState === 'loading'\) \{\s*return/)
  assert.match(app, /storage\?\.get\('cache\/board\.json'\)/)
  assert.match(app, /api\.getBootstrap\(\)/)
  const bootstrap = app.slice(app.indexOf('async function loadBootstrap()'), app.indexOf('const loadEarlierFeed'))
  assert.match(bootstrap, /loadMe\(\{ background: true, verified: result\.me \}\)/)
  assert.doesNotMatch(bootstrap, /if \(!result\.me\?\.connected\)/)
  assert.match(app, /reconcileFeedPage\(posts, current, api\.BOARD_PAGE_SIZE\)/)
  assert.match(app, /loadEarlierFeed/)
  assert.match(app, /feedNextCursor \?\? before/)
  assert.match(app, /next_cursor !== undefined/)
  assert.match(app, /next_cursor: nextCursor === undefined \? feedNextCursorRef\.current : nextCursor/)
  assert.match(app, /const cachedCursor = cached\.next_cursor === null \|\| typeof cached\.next_cursor === 'string'/)
  assert.match(app, /feedNextCursorRef\.current = cachedCursor/)
  assert.doesNotMatch(app, /feedNextCursorRef\.current = cachedCursor \?\? null/)
  assert.match(board, /const chronologicalFeed = feed[\s\S]*\.reverse\(\)/)
  assert.match(board, /chronologicalFeed\.map/)
  assert.match(board, /className="cn-board-composer"/)
  assert.match(board, /placeholder="Message everyone…"/)
  assert.match(board, /className="cn-board-send"/)
  assert.match(board, /<Paperclip aria-hidden="true" \/>/)
  assert.doesNotMatch(board, /<ImageSquare/)
  assert.match(board, /const initialScrollDone = useRef\(false\)/)
  assert.match(board, /const firstReadyScroll = !initialScrollDone\.current/)
  assert.match(board, /scroller\.scrollTop = scroller\.scrollHeight/)
  assert.doesNotMatch(app, /cn-compose-fab/)
  assert.doesNotMatch(board, /aria-label="New post"/)
  assert.match(board, /Load earlier messages/)
  assert.doesNotMatch(board, /landingImage/)
  assert.match(board, /before === null \|\| before === undefined \|\| loadingEarlier/)
})

test('board warms real threads without fetching known empty threads', () => {
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')
  assert.match(board, /REPLY_PREFETCH_LIMIT = 8/)
  assert.match(board, /REPLY_CACHE_LIMIT = 64/)
  assert.match(board, /Number\(post\.reply_count \|\| 0\) === 0/)
  assert.match(board, /className="cn-post-delete"/)
  assert.match(app, /host=\{me\?\.host\} size="small" remote/)
})

test('people and accepted messages use real avatars without flooding a large directory', () => {
  const people = readFileSync(new URL('../ui/People.jsx', import.meta.url), 'utf8')
  const messages = readFileSync(new URL('../ui/Messages.jsx', import.meta.url), 'utf8')
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')
  assert.match(people, /<Avatar name=\{user\.handle\} host=\{user\.host\} remote lazy \/>/)
  assert.match(messages, /remote=\{!showingRequests\}/)
  assert.match(messages, /host=\{showingRequests \? undefined : item\.peer\}/)
  assert.match(messages, /className="cn-request-banner"/)
  assert.match(people, /cache\/people\.json/)
  assert.match(people, /DIRECTORY_CACHE_MAX_AGE_MS = 60_000/)
  assert.match(app, /api\.searchPeople\('', undefined, \{ background: true \}\)/)
  assert.match(board, /subscribeAvatar\(record, update\)/)
  assert.doesNotMatch(board, /AVATAR_CONCURRENCY/)
  assert.match(app, /primeAvatar\(result\.me\?\.host, result\.me\?\.avatar\)/)
})

test('publishing swaps one optimistic row into the confirmed feed without a second fetch', () => {
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')
  const publish = board.slice(board.indexOf('async function publish()'), board.indexOf('async function submitPost()'))
  assert.ok(publish.indexOf('setPending({') < publish.indexOf('await collectImagePayloads(images, text)'))
  assert.match(publish, /const receipt = await publishPost/)
  assert.match(publish, /onPostConfirmed\?\.\(\{/)
  assert.doesNotMatch(publish, /await onRefresh\(true\)/)
  assert.match(board, /<Avatar name=\{pending\.handle\} host=\{pending\.host\} remote \/>/)
  assert.match(app, /const acceptPublishedPost = useCallback/)
  assert.match(app, /onPostConfirmed=\{acceptPublishedPost\}/)
})

test('confirmed deletion never restores focus to the disappearing trigger', () => {
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const focus = readFileSync(new URL('../ui/modalFocus.js', import.meta.url), 'utf8')
  assert.match(board, /restoreDeleteFocus\.current = false/)
  assert.match(board, /\(\) => restoreDeleteFocus\.current/)
  assert.match(focus, /if \(restore && opener/)
})

test('navigation uses one component in a stable desktop toolbar and mobile tab bar', () => {
  const app = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')
  const theme = readFileSync(new URL('../theme.js', import.meta.url), 'utf8')
  const wide = theme.slice(theme.indexOf('@media (min-width: 720px)'), theme.indexOf('@media (max-width: 480px)'))
  assert.match(app, /function MainNavigation\(/)
  assert.match(app, /className="cn-nav-wide"/)
  assert.match(app, /className="cn-nav-mobile"/)
  assert.match(app, /<span>Community<\/span>/)
  assert.match(app, /<span>Chats<\/span>/)
  assert.match(app, /<span>People<\/span>/)
  assert.match(app, /<h1 className="cn-title">Social<\/h1>/)
  assert.match(theme, /\.cn-nav-wide \{ display: none; \}/)
  assert.match(wide, /\.cn-nav-mobile \{ display: none; \}/)
  assert.match(wide, /\.cn-nav-wide \{[\s\S]*grid-column: 2; grid-row: 1; display: flex;/)
  assert.match(wide, /\.cn-nav-wide \.cn-nav-item \{[\s\S]*min-height: 44px;/)
  assert.match(theme, /\.cn-board-composer \{[\s\S]*position: sticky;[\s\S]*bottom: 0;/)
})

test('compact reaction visuals keep real 44 pixel controls', () => {
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const theme = readFileSync(new URL('../theme.js', import.meta.url), 'utf8')
  assert.match(board, /className="cn-reaction-visual"/)
  assert.match(theme, /\.cn-reaction-chip \{[\s\S]*width: auto; min-width: 44px; height: 44px;/)
  assert.match(theme, /\.cn-reaction-visual \{[\s\S]*height: 30px;/)
  assert.match(theme, /\.cn-reaction-grid button \{[\s\S]*width: 44px; height: 44px;/)
})

test('high-cardinality phone reactions wrap without clipping accessible controls', () => {
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const theme = readFileSync(new URL('../theme.js', import.meta.url), 'utf8')
  assert.match(theme, /\.cn-post-actions \{[^}]*flex-wrap: wrap;/)
  assert.match(theme, /\.cn-reactions \{[\s\S]*flex: 1 1 180px; flex-wrap: wrap;/)
  assert.doesNotMatch(theme, /\.cn-reactions \{ flex-basis: 100%; \}/)
  assert.match(board, /visibleReactions\.map\(\(emoji\) =>/)
  assert.doesNotMatch(board, /visibleReactions\.slice/)
  assert.match(board, /canInteract \? reactionActionLabel\(reactions\[emoji\], emoji\) : 'Join Social to react'/)
  assert.doesNotMatch(board, /className="cn-reaction-anchor"/)
  assert.match(board, /className="cn-reactions"[\s\S]*aria-label=\{!canInteract \? 'Join Social to react'[\s\S]*className="cn-reaction-picker"/)
})

test('reaction picker width fits every 44 pixel choice without horizontal spill', () => {
  const board = readFileSync(new URL('../ui/Board.jsx', import.meta.url), 'utf8')
  const theme = readFileSync(new URL('../theme.js', import.meta.url), 'utf8')
  assert.match(theme, /\.cn-reaction-picker \{[\s\S]*width: max-content;/)
  // It floats over the posts below and opens downward, so a first post's
  // choices can never sit above the top of the feed.
  assert.match(theme, /\.cn-reaction-picker \{[^}]*position: absolute;[^}]*top: calc\(100% \+ 6px\);/)
  assert.doesNotMatch(theme, /\.cn-reaction-picker \{[^}]*bottom:/)
  assert.match(theme, /\.cn-reaction-grid \{ display: grid; grid-template-columns: repeat\(6, 44px\); gap: 3px; \}/)
  assert.match(theme, /\.cn-reaction-grid \{ grid-template-columns: repeat\(5, 44px\); \}/)
  assert.match(theme, /\.cn-reaction-grid \{ grid-template-columns: repeat\(4, 44px\); \}/)
  assert.match(board, /if \(event\.key === 'Escape'\)/)
  assert.match(board, /aria-pressed=\{reactions\[emoji\]\.reacted\}/)
})
test('handle search accepts the displayed @handle form and surrounding spaces', async () => {
  const original = globalThis.fetch
  let url
  globalThis.fetch = async path => {
    url = path
    return { ok: true, json: async () => ({ users: [] }) }
  }
  try {
    await searchPeople(' @example ')
    assert.equal(new URL(url, 'https://local.example').searchParams.get('q'), 'example')
  } finally { globalThis.fetch = original }
})
