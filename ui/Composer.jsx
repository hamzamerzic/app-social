import { useLayoutEffect, useRef } from 'react'
import { ArrowUp, Plus } from '@openai/apps-sdk-ui/components/Icon'
import MessageInput, { keepMessageFocus } from './MessageInput.jsx'

export function ComposerAttachmentButton({ onClick, disabled, label = 'Attach photo' }) {
  return <button className="cn-composer-attach" type="button" onClick={onClick}
                 onMouseDown={keepMessageFocus} disabled={disabled} aria-label={label}>
    <Plus aria-hidden="true" />
  </button>
}

export default function Composer({
  value, onChange, onSubmit, onFocus, disabled, sendDisabled, placeholder = 'Message',
  maxLength, label = placeholder, sendLabel = 'Send', inputRef, attachmentAction,
  children, className = '',
}) {
  const fallbackRef = useRef(null)
  const textareaRef = inputRef || fallbackRef
  return <form className={`cn-composer ${className}`.trim()} onSubmit={onSubmit}>
    {attachmentAction}
    <div className={`cn-composer-pill${children ? ' has-children' : ''}`}>
      {children}
      <div className="cn-composer-input-line">
        <MessageInput inputRef={textareaRef} value={value} onChange={onChange} onFocus={onFocus}
                      disabled={disabled} placeholder={placeholder} label={label} maxLength={maxLength} />
        <button className="cn-composer-send" type="submit" onMouseDown={keepMessageFocus}
                disabled={sendDisabled} aria-label={sendLabel}>
          <ArrowUp aria-hidden="true" />
        </button>
      </div>
    </div>
  </form>
}

// The overlay is transparent and click-through outside its controls. Reserve
// exactly its measured height in the supplied scroller, including multiline
// growth and attachments, so the last item remains reachable underneath it.
export function ComposerFooter({ scrollRef, children, className = '' }) {
  const footerRef = useRef(null)
  useLayoutEffect(() => {
    const footer = footerRef.current
    const scroll = scrollRef?.current
    if (!footer || !scroll) return
    const previous = scroll.style.paddingBottom
    const base = parseFloat(getComputedStyle(scroll).paddingBottom) || 0
    const update = () => {
      const pinned = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 72
      const safeBottom = parseFloat(getComputedStyle(footer).bottom) || 0
      scroll.style.paddingBottom = `${base + footer.getBoundingClientRect().height + safeBottom + 8}px`
      if (pinned) scroll.scrollTop = scroll.scrollHeight
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(footer)
    return () => {
      observer.disconnect()
      scroll.style.paddingBottom = previous
    }
  }, [scrollRef])
  return <div ref={footerRef} className={`cn-composer-footer ${className}`.trim()}>{children}</div>
}
