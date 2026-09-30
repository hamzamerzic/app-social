const ID = /^[a-f0-9-]{8,64}$/

// Legacy board notifications still open the board. New ones name both levels
// explicitly; never interpret a reply id as a post id.
export function parseBoardIntent(intent) {
  const [kind, postId, replyId, extra] = String(intent || '').split(':')
  if (kind !== 'board') return null
  if (postId === undefined) return { postId: null, replyId: null }
  if (!ID.test(postId) || (replyId && !ID.test(replyId)) || extra !== undefined) return null
  return { postId, replyId: replyId || null }
}

// The feed already owns pagination. Notification navigation uses that same
// contract and returns discovered rows without replacing a loaded scrollback.
// A cyclic/ambiguous cursor is unavailable, not evidence that a post was deleted.
export async function locateBoardPost(postId, loadPage, pageSize, { signal } = {}) {
  const discovered = new Map()
  const cursors = new Set()
  let cursor = null
  while (true) {
    signal?.throwIfAborted()
    const page = await loadPage(cursor, { signal })
    signal?.throwIfAborted()
    const posts = Array.isArray(page.posts) ? page.posts : []
    for (const post of posts) if (post?.id) discovered.set(post.id, post)
    const post = posts.find(item => item?.id === postId)
    const next = page.next_cursor !== undefined
      ? page.next_cursor : posts.length === pageSize ? posts.at(-1)?.created_at : null
    if (post) return {
      post, posts: [...discovered.values()], capabilities: page.capabilities,
      nextCursor: page.next_cursor, hasEarlier: next !== null && next !== undefined,
    }
    if (next === null || next === undefined) return { post: null, posts: [...discovered.values()] }
    if (cursors.has(String(next))) throw new Error('Community navigation could not finish loading. Try again.')
    cursors.add(String(next))
    cursor = next
  }
}

export function mergeDiscoveredPosts(current, discovered) {
  return [...new Map([...current, ...discovered].map(post => [post.id, post])).values()]
    .sort(comparePosition)
}

function comparePosition(a, b) {
  const date = Number(b.created_at || 0) - Number(a.created_at || 0)
  if (date) return date
  return a.id === b.id ? 0 : a.id < b.id ? 1 : -1
}

// Only move pagination forward when discovery reaches the loaded boundary.
// Finding a recent post must never rewind scrollback that was already loaded.
export function discoveryExtendsFeed(current, discovered) {
  if (!current.length) return true
  if (!discovered.length) return false
  const boundary = [...discovered].sort(comparePosition).at(-1)
  return comparePosition(boundary, current.at(-1)) >= 0
}
