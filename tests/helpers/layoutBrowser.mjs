import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { pathToFileURL } from 'node:url'

// Each fixture owns an offline document and disposable profile. Read its
// completed #result directly: Chrome's CLI dump can hang after the page loads.
export async function renderLayout(chrome, file, { width = 320, height = 860 } = {}) {
  const browser = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking',
    '--remote-debugging-pipe', `--user-data-dir=${join(dirname(file), 'browser')}`,
    `--window-size=${width},${height}`,
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] })
  const spawned = new Promise((resolve, reject) => {
    browser.once('spawn', resolve)
    browser.once('error', reject)
  })
  const closed = new Promise(resolve => browser.once('close', resolve))
  const pending = new Map()
  const events = new Map()
  const decoder = new StringDecoder('utf8')
  let sequence = 0
  let buffer = ''
  let stderr = ''
  let failure
  let pipeError
  const fail = error => {
    failure ||= error
    for (const waiter of [...pending.values(), ...events.values()]) waiter.reject(failure)
    pending.clear()
    events.clear()
  }
  browser.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000) })
  browser.once('error', fail)
  browser.once('close', code => fail(new Error(`Layout browser closed (${code}): ${stderr}`, { cause: pipeError })))
  for (const stream of [browser.stdio[3], browser.stdio[4]]) {
    stream.on('error', error => {
      // A broken protocol pipe cannot yield a result. Close our process and
      // report its stderr rather than a secondary EPIPE/ECONNRESET error.
      pipeError ||= error
      browser.kill()
    })
  }
  browser.stdio[4].on('data', chunk => {
    buffer += decoder.write(chunk)
    let end
    while ((end = buffer.indexOf('\0')) !== -1) {
      const message = JSON.parse(buffer.slice(0, end))
      buffer = buffer.slice(end + 1)
      const map = message.id ? pending : events
      const key = message.id || `${message.sessionId}:${message.method}`
      const waiter = map.get(key)
      if (!waiter) continue
      map.delete(key)
      if (message.error) waiter.reject(new Error(message.error.message))
      else waiter.resolve(message.result || message.params)
    }
  })
  const command = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return }
    const id = ++sequence
    pending.set(id, { resolve, reject })
    browser.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0')
  })
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Layout fixture did not complete within 20 seconds: ${stderr}`)), 20000)
  })
  const measure = async () => {
    await spawned
    const { targetId } = await command('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true })
    await command('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false,
    }, sessionId)
    await command('Page.enable', {}, sessionId)
    const loaded = new Promise((resolve, reject) => events.set(`${sessionId}:Page.loadEventFired`, { resolve, reject }))
    await Promise.all([loaded, command('Page.navigate', { url: pathToFileURL(file).href }, sessionId)])
    const viewport = await command('Runtime.evaluate', {
      expression: '({ width: innerWidth, height: innerHeight })', returnByValue: true,
    }, sessionId)
    if (viewport.result.value.width !== width || viewport.result.value.height !== height) {
      throw new Error(`Layout viewport mismatch: requested ${width}x${height}, got ${JSON.stringify(viewport.result.value)}`)
    }
    const result = await command('Runtime.evaluate', {
      expression: `new Promise(resolve => {
        const observer = new MutationObserver(read)
        function read() {
          const value = document.querySelector('#result')?.textContent.trim()
          if (value) { observer.disconnect(); resolve(value) }
        }
        observer.observe(document, { subtree: true, childList: true, characterData: true })
        read()
      })`,
      awaitPromise: true, returnByValue: true,
    }, sessionId)
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return JSON.parse(result.result.value)
  }
  try {
    return await Promise.race([measure(), deadline])
  } finally {
    clearTimeout(timer)
    if (browser.pid && browser.exitCode === null) {
      const kill = setTimeout(() => browser.kill('SIGKILL'), 2000)
      try { await command('Browser.close') } catch { /* process may already have closed */ }
      await closed
      clearTimeout(kill)
    }
  }
}
