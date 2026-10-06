import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CSS } from '../theme.js'
import { renderLayout } from './helpers/layoutBrowser.mjs'

const chrome = process.env.CHROME_BIN

test('short threads fit their contents; long threads scroll without hiding the reply composer', { skip: !chrome && 'CHROME_BIN is not configured' }, async () => {
  const folder = mkdtempSync(join(tmpdir(), 'social-thread-sizing-'))
  const file = join(folder, 'test.html')
  const thread = (id, count, picker = false) => `<section class="cn-inline-thread" id="${id}"><div class="cn-inline-replies">${count ? Array.from({length:count},(_,i)=>`<article class="cn-reply-row"><span style="width:32px;flex:0 0 32px">A</span><div class="cn-reply-copy"><p>Reply ${i}</p><div style="height:44px">Reactions</div>${picker ? `<div class="cn-reactions is-reply"><div class="cn-reaction-picker"><div class="cn-reaction-grid">${Array.from({length:24},()=>'<button>R</button>').join('')}</div></div></div>` : ''}</div></article>`).join('') : ''}</div><form class="cn-composer cn-reply-composer"><div class="cn-composer-pill"><div class="cn-composer-input-line"><textarea rows="1"></textarea><button class="cn-composer-send">Send</button></div></div></form></section>`
  writeFileSync(file, `<style>:root {--font:sans-serif;--bg:#fff;--surface:#fff;--text:#111;--border:#ccc} *{box-sizing:border-box} body{margin:0;width:320px;padding:16px}${CSS}.cn-inline-thread{width:calc(100% - 54px);margin-left:54px}.cn-reply-row,.cn-reaction-picker{animation:none}</style>${thread('empty',0)}${thread('one',1)}${thread('many',20)}${thread('picker',1,true)}<pre id="result"></pre><script>document.querySelector('#result').textContent=JSON.stringify(['empty','one','many','picker'].map(id=>{const t=document.getElementById(id),p=t.querySelector('.cn-reaction-picker'),r=t.querySelector('.cn-inline-replies'),c=t.querySelector('form'),b=t.getBoundingClientRect(),cb=c.getBoundingClientRect();return {id,pickerFits:!p||[...p.querySelectorAll('button')].every(n=>{const a=n.getBoundingClientRect(),z=p.getBoundingClientRect();return a.width===44&&a.height===44&&a.left>=z.left&&a.right<=z.right}),height:b.height,scroll:r.scrollHeight>r.clientHeight,composerVisible:cb.top>=b.top&&cb.bottom<=b.bottom+1}}))</script>`)
  try {
    const rows = await renderLayout(chrome, file)
    assert.ok(rows[0].height<220)
    assert.ok(rows[1].height<260)
    assert.equal(rows[0].scroll,false)
    assert.equal(rows[1].scroll,false,JSON.stringify(rows))
    assert.equal(rows[2].scroll,true)
    assert.ok(rows.every(row=>row.composerVisible),JSON.stringify(rows))
    assert.equal(rows[3].pickerFits,true,JSON.stringify(rows))
  } finally { rmSync(folder,{recursive:true,force:true}) }
})
