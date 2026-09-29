import test from 'node:test'
import assert from 'node:assert/strict'
import { previewFor, textParts } from '../links.js'

test('post links stay clickable without swallowing trailing punctuation', () => {
  assert.deepEqual(textParts('See https://example.com/path, then reply.'), [
    { type: 'text', value: 'See ' },
    { type: 'link', value: 'https://example.com/path' },
    { type: 'text', value: ',' },
    { type: 'text', value: ' then reply.' },
  ])
})

test('closing quotes and unmatched brackets stay outside the link', () => {
  const links = text => textParts(text).filter(part => part.type === 'link').map(part => part.value)
  assert.deepEqual(links('He said "https://example.com/a" twice'), ['https://example.com/a'])
  assert.deepEqual(links('Try “https://example.com/b”.'), ['https://example.com/b'])
  assert.deepEqual(links("Try 'https://example.com/b' next"), ['https://example.com/b'])
  assert.deepEqual(links('Try ‘https://example.com/b’ next'), ['https://example.com/b'])
  assert.deepEqual(links('(see https://example.com/c)'), ['https://example.com/c'])
})

test('a URL ending in an apostrophe keeps its path unless the link was quoted', () => {
  assert.deepEqual(textParts("https://example.com/users'"), [
    { type: 'link', value: "https://example.com/users'" },
  ])
  assert.deepEqual(textParts("'https://example.com/users'"), [
    { type: 'text', value: "'" },
    { type: 'link', value: 'https://example.com/users' },
    { type: 'text', value: "'" },
  ])
  assert.deepEqual(textParts("'https://example.com/users''"), [
    { type: 'text', value: "'" },
    { type: 'link', value: "https://example.com/users'" },
    { type: 'text', value: "'" },
  ])
  assert.deepEqual(textParts('https://example.com/users’'), [
    { type: 'link', value: 'https://example.com/users’' },
  ])
})

test('a full-size post with many unmatched brackets has one clean link', () => {
  const suffix = ')'.repeat(3900)
  assert.deepEqual(textParts(`https://example.com/${suffix}`), [
    { type: 'link', value: 'https://example.com/' },
    { type: 'text', value: suffix },
  ])
})

test('brackets that belong to the address stay in the link', () => {
  assert.deepEqual(textParts('Read https://en.wikipedia.org/wiki/Foo_(bar), then reply.'), [
    { type: 'text', value: 'Read ' },
    { type: 'link', value: 'https://en.wikipedia.org/wiki/Foo_(bar)' },
    { type: 'text', value: ',' },
    { type: 'text', value: ' then reply.' },
  ])
})

test('social links produce a restrained platform preview', () => {
  assert.deepEqual(previewFor('New post https://x.com/mobius/status/1'), {
    url: 'https://x.com/mobius/status/1',
    label: 'X',
    detail: 'x.com/mobius/status/1',
    social: true,
  })
})
