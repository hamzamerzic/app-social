import { useRef } from 'react'
import { Reply, X } from '@openai/apps-sdk-ui/components/Icon'
import { MessageImage } from './Media.jsx'

function useReplyLongPress(onReply) {
  const press = useRef(null)
  const consumed = useRef(false)

  function clear() {
    if (press.current?.timer) clearTimeout(press.current.timer)
    press.current = null
  }

  return {
    onPointerDown(event) {
      if (event.pointerType === 'mouse' || !onReply) return
      consumed.current = false
      const start = { x: event.clientX, y: event.clientY }
      start.timer = setTimeout(() => {
        consumed.current = true
        onReply()
        press.current = null
      }, 450)
      press.current = start
    },
    onPointerMove(event) {
      const start = press.current
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) clear()
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    onClickCapture(event) {
      if (!consumed.current) return
      consumed.current = false
      event.preventDefault()
      event.stopPropagation()
    },
  }
}

function handleLabel(handle) {
  const clean = String(handle || 'Unknown').replace(/^@/, '')
  return clean === 'Unknown' ? clean : `@${clean}`
}

export function replyTargetFor(message, authorHandle) {
  const text = String(message.text || '').trim()
  return {
    id: message.id,
    author_handle: String(authorHandle || 'Unknown').replace(/^@/, ''),
    excerpt: Array.from(text || '📷 Photo').slice(0, 140).join(''),
  }
}

export function ReplyTarget({ reply, onDismiss }) {
  if (!reply) return null
  return (
    <div className="cn-reply-target">
      <span className="cn-reply-target-copy">
        <strong>{handleLabel(reply.author_handle)}</strong>
        <span>{reply.excerpt}</span>
      </span>
      <button type="button" onClick={onDismiss} aria-label="Cancel reply">
        <X aria-hidden="true" />
      </button>
    </div>
  )
}

function Quote({ reply }) {
  if (!reply) return null
  return (
    <div className="cn-quote">
      <strong>{handleLabel(reply.author_handle)}</strong>
      <span>{reply.excerpt}</span>
    </div>
  )
}

export default function MessageBubble({
  message, mine, tick, avatar, indent, conversationPath, onOpenImage, onImageUnavailable, onReply,
}) {
  const canReply = !!onReply && !String(message.id || '').startsWith('local-') && message.status !== 'sending'
  const longPress = useReplyLongPress(canReply ? onReply : null)

  const replyButton = canReply && (
    <button className="cn-bubble-reply" type="button" onClick={onReply} aria-label="Reply to message">
      <Reply aria-hidden="true" />
    </button>
  )

  return (
    <div className={`cn-message-line ${mine ? 'is-mine' : 'is-theirs'}${indent ? ' no-avatar' : ''}`}>
      {!mine && <span className="cn-message-avatar">{avatar}</span>}
      {mine && replyButton}
      <div
        className={`cn-bubble ${mine ? 'is-mine' : 'is-theirs'}${message.status === 'failed' ? ' is-failed' : ''}${message.attachment ? ' has-attachment' : ''}`}
        onContextMenu={(event) => { if (canReply) event.preventDefault() }}
        {...longPress}
      >
        <Quote reply={message.reply_to} />
        <MessageImage attachment={message.attachment} conversationPath={conversationPath}
                      onOpen={onOpenImage} onUnavailable={onImageUnavailable} />
        {message.text && <span className="cn-bubble-copy">{message.text}</span>}
        <span className="cn-bubble-time">{message.time}{tick}</span>
      </div>
      {!mine && replyButton}
    </div>
  )
}
