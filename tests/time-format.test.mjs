import test from 'node:test'
import assert from 'node:assert/strict'
import { clockTime, postDateTime } from '../api.js'

// Pretend the reader's browser uses a 12-hour locale.
function inLocale(locale, run) {
  const { toLocaleString, toLocaleTimeString } = Date.prototype
  Date.prototype.toLocaleString = function (_, options) { return toLocaleString.call(this, locale, options) }
  Date.prototype.toLocaleTimeString = function (_, options) { return toLocaleTimeString.call(this, locale, options) }
  try { return run() } finally {
    Date.prototype.toLocaleString = toLocaleString
    Date.prototype.toLocaleTimeString = toLocaleTimeString
  }
}

test('message and post times use a 24-hour clock that starts at 00', () => {
  const justAfterMidnight = new Date(2026, 0, 1, 0, 5).getTime() / 1000
  const afternoon = new Date(2026, 0, 1, 15, 30).getTime() / 1000
  inLocale('en-US', () => {
    assert.equal(clockTime(justAfterMidnight), '00:05')
    assert.equal(clockTime(afternoon), '15:30')
    assert.match(postDateTime(justAfterMidnight), /\b00:05$/)
    assert.doesNotMatch(postDateTime(afternoon), /AM|PM/)
  })
})
