import { useEffect, useRef, useState } from 'react'
import {
  ArrowUp, Chat, Heart, HeartFilled, ImageSquare, Plus,
} from '@openai/apps-sdk-ui/components/Icon'
import {
  avatarHue, getPeerAvatar, getReplies, initials, likePost, postReply,
  publishPost, timeAgo,
} from '../api.js'
import { LANDING_DATA_URL } from './landingImage.js'
import { BoardImage, prepareImage, SelectedImageStrip } from './Media.jsx'

const avatarCache = new Map()

function cachedAvatar(host) {
  const key = String(host)
  let record = avatarCache.get(key)
  if (record) return record

  record = { url: null, promise: null }
  record.promise = getPeerAvatar(key)
    .then((blob) => {
      if (!blob?.size) return
      record.url = URL.createObjectURL(blob)
    })
    .catch(() => {})
  avatarCache.set(key, record)
  return record
}

function Avatar({ name, host, size }) {
  const hue = avatarHue(host)
  const cacheKey = host ? String(host) : ''
  const [avatarUrl, setAvatarUrl] = useState(() => avatarCache.get(cacheKey)?.url || null)

  useEffect(() => {
    let active = true
    if (!cacheKey) {
      setAvatarUrl(null)
      return () => { active = false }
    }
    const record = cachedAvatar(cacheKey)
    setAvatarUrl(record.url)
    record.promise.then(() => { if (active) setAvatarUrl(record.url) })
    return () => { active = false }
  }, [cacheKey])

  function useFallback() {
    const record = avatarCache.get(cacheKey)
    if (record?.url === avatarUrl) {
      URL.revokeObjectURL(record.url)
      record.url = null
    }
    setAvatarUrl(null)
  }

  return (
    <span
      className={`cn-avatar${size ? ` is-${size}` : ''}${avatarUrl ? ' has-image' : ''}`}
      style={{ background: `linear-gradient(150deg, hsl(${hue} 62% 58%), hsl(${(hue + 24) % 360} 55% 38%))` }}
      aria-hidden="true"
    >
      {avatarUrl
        ? <img className="cn-avatar-image" src={avatarUrl} alt="" draggable="false" onError={useFallback} />
        : initials(name, host)}
    </span>
  )
}

export { Avatar }

export default function Board({
  me, feed, feedState, onRefresh, onOpenPerson, showToast, onOpenImage,
  composing, setComposing,
}) {
  const [draft, setDraft] = useState('')
  const [posting, setPosting] = useState(false)
  const [processingImage, setProcessingImage] = useState(false)
  const [selectedImage, setSelectedImage] = useState(null)
  const [likeOverrides, setLikeOverrides] = useState({})
  const [replyCounts, setReplyCounts] = useState({})
  const [replyPost, setReplyPost] = useState(null)
  const [replies, setReplies] = useState([])
  const [replyState, setReplyState] = useState('idle')
  const [replyError, setReplyError] = useState('')
  const [replyDraft, setReplyDraft] = useState('')
  const [replySending, setReplySending] = useState(false)
  const replyRequest = useRef(0)
  const fileRef = useRef(null)

  function countFor(post, counts = replyCounts) {
    const count = Number(counts[post.id] ?? post.reply_count ?? 0)
    return Number.isFinite(count) ? count : 0
  }

  async function loadReplies(post) {
    const request = ++replyRequest.current
    setReplyState('loading')
    setReplyError('')
    try {
      const result = await getReplies(post.id)
      if (request !== replyRequest.current) return
      const loaded = result.replies || []
      setReplies(loaded)
      setReplyCounts((prior) => ({ ...prior, [post.id]: loaded.length }))
      setReplyState('ready')
    } catch (error) {
      if (request !== replyRequest.current) return
      setReplyError(error.status === 404
        ? 'Replies aren’t available on this server yet.'
        : 'Replies couldn’t be loaded right now.')
      setReplyState('error')
    }
  }

  function openReplies(post) {
    setReplyPost(post)
    setReplies([])
    setReplyDraft('')
    loadReplies(post)
  }

  function closeReplies() {
    replyRequest.current += 1
    setReplyPost(null)
    setReplyState('idle')
    setReplyError('')
  }

  async function sendReply(event) {
    event.preventDefault()
    const text = replyDraft.trim()
    const post = replyPost
    if (!text || !post || replySending || replyState !== 'ready') return

    const localId = `local-${Date.now()}`
    const optimistic = {
      id: localId,
      host: me?.host,
      handle: me?.handle,
      text,
      created_at: Date.now() / 1000,
      pending: true,
    }
    setReplySending(true)
    setReplies((prior) => [...prior, optimistic])
    setReplyCounts((prior) => ({ ...prior, [post.id]: countFor(post, prior) + 1 }))
    setReplyDraft('')
    try {
      await postReply(post.id, text)
      setReplies((prior) => prior.map((reply) => (
        reply.id === localId ? { ...reply, pending: false } : reply
      )))
      window.mobius?.signal?.('item_created', { type: 'board_reply' })
      onRefresh()
    } catch (error) {
      setReplies((prior) => prior.filter((reply) => reply.id !== localId))
      setReplyCounts((prior) => ({
        ...prior,
        [post.id]: Math.max(0, countFor(post, prior) - 1),
      }))
      setReplyDraft(text)
      showToast(error.status === 404
        ? 'Replies aren’t available on this server yet.'
        : error.message, 'error')
    } finally {
      setReplySending(false)
    }
  }

  async function toggleLike(post) {
    const current = likeOverrides[post.id] || {
      liked: !!post.liked, count: post.like_count || 0,
    }
    const next = {
      liked: !current.liked,
      count: Math.max(0, current.count + (current.liked ? -1 : 1)),
    }
    setLikeOverrides((prior) => ({ ...prior, [post.id]: next }))
    try {
      const result = await likePost(post.id)
      setLikeOverrides((prior) => ({
        ...prior, [post.id]: { liked: result.liked, count: result.likes },
      }))
    } catch (error) {
      setLikeOverrides((prior) => ({ ...prior, [post.id]: current }))
      showToast(error.message, 'error')
    }
  }

  async function chooseImage(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setProcessingImage(true)
    try {
      setSelectedImage(await prepareImage(file))
    } catch (error) {
      showToast(error.message, 'error')
    } finally {
      setProcessingImage(false)
    }
  }

  async function publish() {
    const text = draft.trim()
    const image = selectedImage
    if (!text && !image) return
    setPosting(true)
    try {
      await publishPost(text, image?.payload)
      window.mobius?.signal?.('item_created', { type: 'board_post' })
      setDraft('')
      setSelectedImage(null)
      setComposing(false)
      showToast('Posted to the board', 'success')
      onRefresh()
    } catch (error) {
      window.mobius?.signal?.('error', { message: error.message, source: 'publish' })
      showToast(
        (error.status === 400 || error.status === 404) && image
          ? 'Photo posts aren’t available on this server yet.'
          : error.message,
        'error',
      )
    } finally {
      setPosting(false)
    }
  }

  return (
    <div className="cn-content cn-screen">


      {feedState === 'loading' && <div className="cn-center"><div className="cn-spinner" /></div>}
      {feedState === 'error' && (
        <div className="cn-empty">
          <div className="cn-empty-title">The board is unreachable</div>
          <p className="cn-empty-text">Your community host couldn’t be reached right now.</p>
          <button className="cn-btn cn-btn-secondary" onClick={onRefresh}>Try again</button>
        </div>
      )}
      {feedState === 'ready' && feed.length === 0 && (
        <div className="cn-empty">
          {LANDING_DATA_URL
            ? <img className="cn-landing" style={{ maxWidth: 180, opacity: 0.9 }} src={LANDING_DATA_URL} alt="" />
            : <div className="cn-empty-mark" aria-hidden="true"><Chat /></div>}
          <div className="cn-empty-title">Your board is quiet</div>
          <p className="cn-empty-text">
            Posts from everyone on your community appear here. Share Social
            with friends so their servers can join yours.
          </p>
        </div>
      )}
      <div className="cn-feed">
        {feed.map((post) => {
          const like = likeOverrides[post.id] || {
            liked: !!post.liked, count: post.like_count || 0,
          }
          const replyCount = countFor(post)
          return (
            <article className="cn-post" key={post.id}>
              <div className="cn-post-head">
                <Avatar name={post.handle} host={post.host} />
                <button className="cn-person" onClick={() => onOpenPerson(post.host)}>
                  <span>
                    <span className="cn-person-name">{post.handle ? `@${post.handle}` : 'Social member'}</span>
                    <span className="cn-meta" style={{ display: 'block' }}>
                      {timeAgo(post.created_at)}
                    </span>
                  </span>
                </button>
              </div>
              {post.text && <p className="cn-post-copy">{post.text}</p>}
              <BoardImage
                post={post}
                onOpen={onOpenImage}
                onUnavailable={(error) => showToast(
                  error?.status === 404
                    ? 'Board photos aren’t available on this server yet.'
                    : 'This photo couldn’t be loaded.',
                  'error',
                )}
              />
              <div className="cn-post-actions">
                <button
                  className={`cn-react${like.liked ? ' is-liked' : ''}`}
                  onClick={() => toggleLike(post)}
                  aria-label={like.liked ? 'Unlike' : 'Like'}
                >
                  {like.liked ? <HeartFilled aria-hidden="true" /> : <Heart aria-hidden="true" />}
                  {like.count > 0 && <span>{like.count}</span>}
                </button>
                <button
                  className="cn-react"
                  onClick={() => openReplies(post)}
                  aria-label={`View ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`}
                >
                  <Chat aria-hidden="true" />
                  <span>{replyCount}</span>
                </button>
              </div>
            </article>
          )
        })}
      </div>


      {composing && (
        <div className="cn-scrim" role="dialog" aria-modal="true" aria-label="New post"
             onClick={posting ? null : () => setComposing(false)}>
          <div className="cn-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="cn-grabber" aria-hidden="true" />
            <h3 className="cn-sheet-title">New post</h3>
            <p className="cn-sheet-body">Posting to everyone on your community board.</p>
            <SelectedImageStrip selected={selectedImage} onRemove={() => setSelectedImage(null)} />
            <div className="cn-post-compose">
              <textarea
                className="cn-textarea"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="What would you like to share?"
                autoFocus
              />
              <input ref={fileRef} className="cn-file-input" type="file" accept="image/*"
                     onChange={chooseImage} tabIndex={-1} aria-hidden="true" />
              <button className="cn-compose-image" type="button" onClick={() => fileRef.current?.click()}
                      disabled={posting || processingImage} aria-label="Attach photo">
                {processingImage ? <span className="cn-spinner" /> : <ImageSquare aria-hidden="true" />}
              </button>
            </div>
            <div className="cn-post-sheet-actions">
              <button className="cn-btn cn-btn-secondary" onClick={() => setComposing(false)} disabled={posting}>
                Cancel
              </button>
              <button className="cn-btn cn-btn-primary" onClick={publish}
                      disabled={posting || processingImage || (!draft.trim() && !selectedImage)}>
                {posting ? 'Posting…' : 'Post'}
              </button>
            </div>
          </div>
        </div>
      )}

      {replyPost && (
        <div className="cn-scrim" role="dialog" aria-modal="true" aria-label="Replies"
             onClick={replySending ? null : closeReplies}>
          <div className="cn-sheet cn-reply-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="cn-grabber" aria-hidden="true" />
            <div className="cn-reply-sheet-head">
              <div>
                <h3 className="cn-sheet-title">Replies</h3>
                <p className="cn-sheet-body">
                  {countFor(replyPost)} {countFor(replyPost) === 1 ? 'reply' : 'replies'} to this post
                </p>
              </div>
              <button className="cn-btn cn-btn-ghost" onClick={closeReplies} disabled={replySending}>
                Close
              </button>
            </div>

            <div className="cn-reply-list" aria-live="polite">
              {replyState === 'loading' && <div className="cn-center"><div className="cn-spinner" /></div>}
              {replyState === 'error' && (
                <div className="cn-reply-empty">
                  <p>{replyError}</p>
                  <button className="cn-btn cn-btn-secondary" onClick={() => loadReplies(replyPost)}>
                    Try again
                  </button>
                </div>
              )}
              {replyState === 'ready' && replies.length === 0 && (
                <p className="cn-reply-empty">No replies yet — start the conversation.</p>
              )}
              {replies.map((reply) => (
                <article className={`cn-reply-row${reply.pending ? ' is-pending' : ''}`} key={reply.id}>
                  <Avatar name={reply.handle} host={reply.host} size="small" />
                  <div className="cn-reply-copy">
                    <div className="cn-reply-meta">
                      <strong>{reply.handle ? `@${reply.handle}` : 'Social member'}</strong>
                      <span className="cn-time">{reply.pending ? 'Sending…' : timeAgo(reply.created_at)}</span>
                    </div>
                    <p>{reply.text}</p>
                  </div>
                </article>
              ))}
            </div>

            <form className="cn-reply-composer" onSubmit={sendReply}>
              <input
                value={replyDraft}
                onChange={(e) => setReplyDraft(e.target.value)}
                placeholder="Write a reply"
                aria-label="Write a reply"
                autoComplete="off"
                disabled={replyState !== 'ready' || replySending}
              />
              <button className="cn-reply-send" type="submit"
                      disabled={replyState !== 'ready' || replySending || !replyDraft.trim()}
                      aria-label="Send reply">
                <ArrowUp aria-hidden="true" />
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
