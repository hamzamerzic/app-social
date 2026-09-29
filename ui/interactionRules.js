export const MIN_LIGHTBOX_SCALE = 1
export const MAX_LIGHTBOX_SCALE = 4
export const LIGHTBOX_ZOOM_STEP = 0.25
export const TOUCH_PRIMARY_QUERY = '(hover: none) and (pointer: coarse)'

export function isTouchPrimary(scope = globalThis) {
  return scope?.matchMedia?.(TOUCH_PRIMARY_QUERY)?.matches === true
}

export function shouldSubmitMessageKey(event, isTouchPrimary = false) {
  return event?.key === 'Enter'
    && !event.shiftKey
    && !event.isComposing
    && !event.nativeEvent?.isComposing
    && Boolean(event.metaKey || event.ctrlKey || !isTouchPrimary)
}

export function prependedScrollTop(previousTop, previousHeight, nextHeight) {
  return Number(previousTop) + Math.max(0, Number(nextHeight) - Number(previousHeight))
}

export function clampLightboxScale(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return MIN_LIGHTBOX_SCALE
  return Math.min(MAX_LIGHTBOX_SCALE, Math.max(MIN_LIGHTBOX_SCALE, numeric))
}

export function wheelLightboxScale(current, deltaY) {
  const direction = Number(deltaY) < 0 ? 1 : -1
  return clampLightboxScale(Number(current) + direction * LIGHTBOX_ZOOM_STEP)
}

export function pinchLightboxScale(startScale, startDistance, currentDistance) {
  const initial = Number(startDistance)
  if (!Number.isFinite(initial) || initial <= 0) return clampLightboxScale(startScale)
  return clampLightboxScale(Number(startScale) * (Number(currentDistance) / initial))
}
