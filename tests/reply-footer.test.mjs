import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CSS } from '../theme.js'
import { renderLayout } from './helpers/layoutBrowser.mjs'

// Exercise the owning footer effect against real layout, not a second copy of
// its clearance calculation. React supplies these refs in the mounted app.
const source = readFileSync(new URL('../ui/Composer.jsx', import.meta.url), 'utf8')
const effect = source.slice(source.indexOf('export function ComposerFooter')).match(/useLayoutEffect\(\(\) => \{([\s\S]*?)\n  \}, \[scrollRef\]\)/)[1]

test('reply overlay reserves growing draft clearance, stays transparent and restores the scroller on unmount', {
  skip: !process.env.CHROME_BIN && 'CHROME_BIN is not configured',
}, async () => {
  const folder = mkdtempSync(join(tmpdir(), 'social-reply-footer-'))
  const file = join(folder, 'test.html')
  try {
    writeFileSync(file, `<style>:root{--font:sans-serif;--bg:#111;--surface:#222;--text:#fff;--border:#555;--mobius-safe-bottom:24px}*{box-sizing:border-box}body{margin:0}${CSS}</style>
      <section class="cn-inline-thread"><div class="cn-inline-replies">${'<article class="cn-reply-row" style="height:80px">Reply</article>'.repeat(12)}</div><div class="cn-composer-footer cn-reply-footer"><form class="cn-composer cn-reply-composer"><button class="cn-composer-attach"><svg></svg></button><div class="cn-composer-pill"><div class="cn-composer-input-line"><textarea rows="1"></textarea><button class="cn-composer-send">Send</button></div></div></form></div></section><pre id="result"></pre>
      <script>(async()=>{const t=document.querySelector('.cn-inline-thread'),scroll=t.querySelector('.cn-inline-replies'),footer=t.querySelector('.cn-reply-footer'),input=t.querySelector('textarea');const scrollRef={current:scroll},footerRef={current:footer};const cleanup=(()=>{${effect}})();const measure=()=>({height:t.clientHeight,padding:parseFloat(scroll.style.paddingBottom),footerHeight:footer.getBoundingClientRect().height,bottom:getComputedStyle(footer).bottom,transparent:getComputedStyle(footer).backgroundColor,innerFirst:getComputedStyle(scroll).overscrollBehaviorY,targets:[...t.querySelectorAll('button')].map(b=>b.getBoundingClientRect().height),overflow:t.scrollWidth>t.clientWidth});const initial=measure();scroll.scrollTop=100;input.style.height='100px';await new Promise(resolve=>{const o=new ResizeObserver(()=>{if(footer.getBoundingClientRect().height>initial.footerHeight){o.disconnect();requestAnimationFrame(resolve)}});o.observe(footer)});const grown=measure();grown.readingPosition=scroll.scrollTop;scroll.scrollTop=scroll.scrollHeight;grown.lastReplyReachable=scroll.lastElementChild.getBoundingClientRect().bottom<=footer.getBoundingClientRect().top;cleanup();document.querySelector('#result').textContent=JSON.stringify({initial,grown,restored:scroll.style.paddingBottom})})()</script>`)
    for (const width of [320, 426, 1280]) {
      const { initial, grown, restored } = await renderLayout(process.env.CHROME_BIN, file, { width })
      assert.equal(initial.bottom, '0px', 'local reply footer does not inherit the viewport safe inset')
      assert.equal(initial.transparent, 'rgba(0, 0, 0, 0)')
      assert.equal(initial.innerFirst, 'auto', 'preserve the chosen native edge handoff')
      assert.ok(initial.targets.every(h => h >= 44))
      assert.ok(Math.abs(initial.padding - initial.footerHeight - 8) < 1)
      assert.ok(grown.padding > initial.padding)
      assert.equal(grown.readingPosition, 100, 'growth must not pull a reader to the bottom')
      assert.equal(grown.lastReplyReachable, true)
      assert.equal(grown.overflow, false)
      assert.equal(restored, '')
    }
  } finally { rmSync(folder, { recursive: true, force: true }) }
})
