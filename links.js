const URL_RE = /https?:\/\/[^\s<>"]+/gi
const TRAILING_PUNCTUATION = /[.,!?:;…]/
const OPENING_BRACKET = { ')': '(', ']': '[', '}': '{' }
const CLOSING_QUOTE = { "'": "'", '‘': '’', '“': '”' }

// Sentence punctuation stays outside a link, but a closing bracket the address
// opened itself stays inside, as in Wikipedia-style `/wiki/Foo_(bar)` paths.
function trimLink(raw, leadingQuote) {
  const brackets = { '(': 0, ')': 0, '[': 0, ']': 0, '{': 0, '}': 0 }
  for (const char of raw) {
    if (brackets[char] !== undefined) brackets[char]++
  }
  let end = raw.length
  let closingQuote = CLOSING_QUOTE[leadingQuote]
  while (end) {
    const last = raw[end - 1]
    const opener = OPENING_BRACKET[last]
    if (opener && brackets[last] > brackets[opener]) {
      brackets[last]--
    } else if (last === closingQuote) {
      closingQuote = null
    } else if (!TRAILING_PUNCTUATION.test(last)) {
      break
    }
    end--
  }
  return raw.slice(0, end)
}

export function textParts(text) {
  const source = String(text || '')
  const parts = []
  let cursor = 0
  for (const match of source.matchAll(URL_RE)) {
    const raw = match[0]
    const url = trimLink(raw, source[match.index - 1])
    if (match.index > cursor) parts.push({ type: 'text', value: source.slice(cursor, match.index) })
    parts.push({ type: 'link', value: url })
    const punctuation = raw.slice(url.length)
    if (punctuation) parts.push({ type: 'text', value: punctuation })
    cursor = match.index + raw.length
  }
  if (cursor < source.length) parts.push({ type: 'text', value: source.slice(cursor) })
  return parts
}

const SOCIAL_DOMAINS = new Map([
  ['x.com', 'X'], ['twitter.com', 'X'], ['instagram.com', 'Instagram'],
  ['youtube.com', 'YouTube'], ['youtu.be', 'YouTube'], ['tiktok.com', 'TikTok'],
  ['linkedin.com', 'LinkedIn'], ['github.com', 'GitHub'],
])

export function previewFor(text) {
  const first = textParts(text).find(part => part.type === 'link')?.value
  if (!first) return null
  try {
    const parsed = new URL(first)
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
    const social = [...SOCIAL_DOMAINS].find(([domain]) => host === domain || host.endsWith(`.${domain}`))
    return {
      url: first,
      label: social?.[1] || host,
      detail: decodeURIComponent(`${host}${parsed.pathname === '/' ? '' : parsed.pathname}`),
      social: Boolean(social),
    }
  } catch {
    return null
  }
}
