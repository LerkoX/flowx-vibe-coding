// 复现：ask_user 选项按钮点击是否发送 /answer
import { readFileSync } from 'node:fs'
import { JSDOM } from 'file:///data/data/com.termux/files/home/workspace/github.com/LerkoX/flowx-studio/web/node_modules/jsdom/lib/api.js'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.location = dom.window.location
globalThis.confirm = () => true

// ---- 状态ful mock：Studio 日志 API + 桥 ----
let pend = null          // {id,question,kind,options,resolve}
let answered = null
const calls = []
const state = { busy: false, waiting_answer: false, finished: false, aborted: false, error: null, messages: [], dropped: 0, turns: 0, tool_calls: 0, total: 0, auto_finish: true }

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url, 'http://localhost')  // widget 的日志 API 用相对路径
  console.log('FETCH', opts.method || 'GET', u.pathname + u.search)
  if (u.pathname.startsWith('/api/v1/executions/')) {
    return { ok: true, json: async () => ({ data: { items: [{ message: 'VIBE_BRIDGE url=http://127.0.0.1:17800 token=tok123' }] } }) }
  }
  if (u.pathname === '/state') {
    return { ok: true, json: async () => ({ ...state, pending_question: pend && { id: pend.id, question: pend.question, kind: pend.kind, options: pend.options } }) }
  }
  if (u.pathname === '/answer') {
    const body = JSON.parse(opts.body || '{}')
    calls.push(['answer', body])
    if (pend && body.id === pend.id) { answered = body.answer; pend.resolve(body.answer); pend = null; state.busy = true }
    return { ok: true, json: async () => ({ ok: true }) }
  }
  if (u.pathname === '/prompt') { calls.push(['prompt', JSON.parse(opts.body || '{}')]); return { ok: true, json: async () => ({ ok: true }) } }
  return { ok: false, json: async () => ({}) }
}

const code = readFileSync('/data/data/com.termux/files/home/workspace/github.com/LerkoX/flowx-vibe-coding/nodes/pi-vibe-coding/ui/node-widget.js', 'utf8')
  .replace('export default', 'module.exports =')
const mod = { exports: {} }
new Function('module', 'exports', code)(mod, mod.exports)
const mount = mod.exports.default || mod.exports

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const assert = (c, m) => { console.log((c ? 'ok: ' : 'FAIL: ') + m); if (!c) process.exitCode = 1 }

const el = document.createElement('div')
document.body.append(el)
const props = { nodeId: 'Vibe', nodeRef: 'pi-vibe-coding', status: 'running', inputs: [], outputs: {}, params: {}, onParamsChange: () => {}, execution: { id: 99 }, theme: 'dark', locale: 'zh-CN' }
const w = mount(el, props)

await sleep(100) // discover
// pi 提问（confirm 无 options → 默认 确认/拒绝）
let askResolve
const askPromise = new Promise((r) => { askResolve = r })
pend = { id: 'abcd1234', question: '采用方案A吗？', kind: 'confirm', options: [], resolve: askResolve }
await sleep(1700) // 等一轮轮询

// 打开弹窗
const hintEl = [...el.querySelectorAll('div')].find((d) => d.textContent === '💬 点击打开对话窗口')
assert(!!hintEl, '迷你聊天存在')
const miniEl = hintEl.parentElement  // onclick 绑在容器上
assert(typeof miniEl.onclick === 'function', '迷你聊天容器可点击')
miniEl.onclick()
await sleep(50)
const overlay = document.body.lastChild
console.log('DEBUG overlay text:', JSON.stringify(overlay.textContent.slice(0, 300)))
const buttons = [...overlay.querySelectorAll('button')].map((b) => b.textContent)
assert(buttons.includes('确认') && buttons.includes('拒绝'), 'confirm 默认选项按钮出现: ' + buttons.join(','))

// 点击「确认」
const confirmBtn = [...overlay.querySelectorAll('button')].find((b) => b.textContent === '确认')
confirmBtn.onclick()
await sleep(100)
const ansCall = calls.find((c) => c[0] === 'answer')
assert(!!ansCall, '点击选项按钮发出了 /answer: ' + JSON.stringify(calls))
assert(ansCall && ansCall[1].id === 'abcd1234' && ansCall[1].answer === '确认', '/answer 参数正确: ' + JSON.stringify(ansCall && ansCall[1]))
const askResult = await Promise.race([askPromise, sleep(500).then(() => 'TIMEOUT')])
assert(askResult === '确认', '/ask 挂起被唤醒并返回答案: ' + askResult)

w.unmount()
process.exit(process.exitCode || 0)
