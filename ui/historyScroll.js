// A scroll event must represent movement toward older content. Programmatic
// initial positioning and prepend anchoring move the other way, so neither
// should drain the entire cursor chain.
export function reachedEarlierHistory(previousTop, scroller, threshold = 96) {
  return previousTop !== null
    && scroller.scrollTop < previousTop
    && scroller.scrollTop <= threshold
    && scroller.scrollHeight > scroller.clientHeight
}
