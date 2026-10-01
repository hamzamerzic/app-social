import assert from 'node:assert/strict'
import test from 'node:test'
import { renderLayout } from './helpers/layoutBrowser.mjs'

test('layout browser reports a missing executable instead of waiting for a result', async () => {
  await assert.rejects(renderLayout('/missing-layout-browser', 'unused.html'), { code: 'ENOENT' })
})

test('layout browser reports an early exit with its launch error', async () => {
  await assert.rejects(renderLayout(process.execPath, 'unused.html'), /Layout browser closed.*bad option/s)
})
