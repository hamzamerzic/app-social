import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { CSS } from '../theme.js'

test('direct and group chat bubbles use the shared safe link renderer', () => {
  const bubble = readFileSync(new URL('../ui/MessageBubble.jsx', import.meta.url), 'utf8')
  assert.match(bubble, /<RichText className="cn-bubble-copy" text=\{message.text\}/)
  for (const name of ['Thread', 'GroupThread']) {
    assert.match(readFileSync(new URL(`../ui/${name}.jsx`, import.meta.url), 'utf8'), /<MessageBubble/)
  }
})

test('message text and link descendants remain selectable with legible links on both bubble colors', () => {
  assert.match(CSS, /\.cn-bubble-copy \* \{ user-select: text; -webkit-user-select: text;/)
  assert.match(CSS, /\.cn-bubble-copy a \{ color: inherit; text-decoration: underline;/)
  assert.match(CSS, /\.cn-bubble-copy \{[^}]*margin: 0;/)
})
