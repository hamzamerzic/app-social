import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { shouldSubmitMessageKey } from '../ui/interactionRules.js'

const composer = readFileSync(new URL('../ui/Composer.jsx', import.meta.url), 'utf8')
const messageInput = readFileSync(new URL('../ui/MessageInput.jsx', import.meta.url), 'utf8')
const thread = readFileSync(new URL('../ui/Thread.jsx', import.meta.url), 'utf8')
const group = readFileSync(new URL('../ui/GroupThread.jsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../theme.js', import.meta.url), 'utf8')

test('shared composer keeps MessageInput keyboard semantics and input focus on send', () => {
  assert.match(composer, /<MessageInput\b/)
  assert.match(composer, /onMouseDown=\{keepMessageFocus\}/)
  assert.match(messageInput, /shouldSubmitMessageKey\(event, isTouchPrimary\(\)\)/)
  assert.equal(shouldSubmitMessageKey({ key: 'Enter', nativeEvent: {} }, false), true)
  assert.equal(shouldSubmitMessageKey({ key: 'Enter', nativeEvent: {} }, true), false)
  assert.equal(shouldSubmitMessageKey({ key: 'Enter', ctrlKey: true, nativeEvent: {} }, true), true)
  assert.equal(shouldSubmitMessageKey({ key: 'Enter', nativeEvent: { isComposing: true } }, false), false)
})

test('direct and group threads use the shared overlay without disabling input during sends', () => {
  for (const source of [thread, group]) {
    assert.match(source, /<ComposerFooter scrollRef=\{scrollRef\}>/)
    assert.match(source, /<Composer inputRef=\{inputRef\}/)
    assert.match(source, /disabled=\{processingImage\}/)
    assert.match(source, /sendDisabled=\{sending \|\| processingImage/)
    assert.match(source, /<Composer[^>]*disabled=\{processingImage\}/s)
  }
})

test('footer is transparent and measured, while only long inline replies scroll', () => {
  assert.match(composer, /ResizeObserver\(update\)/)
  assert.match(composer, /scroll\.style\.paddingBottom/)
  assert.match(css, /\.cn-composer-footer\s*\{[^}]*background:\s*transparent;[^}]*pointer-events:\s*none/s)
  assert.match(css, /\.cn-composer-footer::before\s*\{[^}]*linear-gradient/s)
  assert.match(css, /\.cn-inline-thread\s*\{[^}]*max-height:/s)
  assert.doesNotMatch(css, /\.cn-inline-thread\s*\{[^}]*[;\s]height:\s*min\(/s)
  assert.match(css, /\.cn-inline-replies\s*\{[^}]*overflow-y:\s*auto/s)
  assert.match(css, /\.cn-reactions\.is-reply \.cn-reaction-picker\s*\{[^}]*position:\s*relative/s)
})
