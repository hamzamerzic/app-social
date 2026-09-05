const ACTIVE_WINDOW_MS = 15_000

function chronological(left, right) {
  return Number(left?.created_at || 0) - Number(right?.created_at || 0)
}

// The server owns canonical reply ids. Keep only genuinely in-flight local rows
// while folding a fresh thread snapshot into the rendered conversation.
export function reconcileReplies(authoritative, current) {
  const landed = Array.isArray(authoritative) ? authoritative.filter(Boolean) : []
  const landedIds = new Set(landed.map(reply => reply?.id).filter(Boolean))
  const pending = (Array.isArray(current) ? current : []).filter(reply => (
    reply?.pending && !landedIds.has(reply.id)
  ))
  return [...landed, ...pending].sort(chronological)
}

export function optimisticLikeChange(post, override) {
  const current = override || {
    liked: Boolean(post?.liked),
    count: Number(post?.like_count || 0),
  }
  return {
    current,
    next: {
      liked: !current.liked,
      count: Math.max(0, current.count + (current.liked ? -1 : 1)),
    },
  }
}

export function boardRefreshDelay(lastActivityAt, now = Date.now()) {
  return now - lastActivityAt < ACTIVE_WINDOW_MS ? 1800 : 5000
}

export function threadRefreshDelay(lastActivityAt, now = Date.now()) {
  return now - lastActivityAt < ACTIVE_WINDOW_MS ? 1200 : 3000
}
