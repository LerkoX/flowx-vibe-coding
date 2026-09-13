// pi-vibe-coding widget 冒烟测试：node + jsdom 直接挂载渲染
import { readFileSync } from 'node:fs'
import { JSDOM } from 'file:///data/data/com.termux/files/home/workspace/github.com/LerkoX/flowx-studio/web/node_modules/jsdom/lib/api.js'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.location = dom.window.location
globalThis.fetch = async () => ({ ok: false, json: async () => ({}) })


const code = readFileSync('/data/data/com.termux/files/home/workspace/github.com/LerkoX/flowx-vibe-coding/nodes/pi-vibe-coding/ui/node-widget.js', 'utf8')
  .replace('export default', 'module.exports =')
const mod = { exports: {} }
new Function('module', 'exports', code)(mod, mod.exports)
const mount = mod.exports.default || mod.exports

const el = document.createElement('div')
document.body.append(el)
let written = null
const props = {
  nodeId: 'Vibe', nodeRef: 'pi-vibe-coding', status: 'idle',
  inputs: [], outputs: {},
  params: {
    workdir: '{{ Param.project_dir }}',
    task: '{{ Param.task_desc }}',
    model: '',
  },
  paramSources: {
    workdir: { kind: 'workflow', paramName: 'project_dir', paramValue: '/data/game/td' },
    task: { kind: 'workflow', paramName: 'task_desc', paramValue: '开发一个塔防游戏\n\n- 排行榜\n- **多关卡**' },
    model: { kind: 'literal' },
  },
  onParamsChange: (p) => { written = p },
  execution: null, theme: 'dark', locale: 'zh-CN',
}
const w = mount(el, props)
const t = el.textContent

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1 } else console.log('ok:', msg) }

assert(t.includes('⚡ 流水线参数 · project_dir = /data/game/td'), 'workdir 来源标注含真实值')
assert(t.includes('⚡ 流水线参数 · task_desc'), 'task 来源标注')
assert(t.includes('模型 · ✏️ 自定义值'), 'model 字段标注')
assert(t.includes('点击打开对话窗口'), '迷你聊天点击提示')
assert(el.querySelectorAll('span').length >= 3, '三灯存在')

// 任务参数：卡片上是 Markdown 预览（解析后的真实值），点击弹窗编辑原始绑定串
const taskPreview = [...el.querySelectorAll('div')].find((d) => d.title && d.title.startsWith('点击查看/编辑任务'))
assert(!!taskPreview, '任务 Markdown 预览存在')
assert(taskPreview.textContent.includes('开发一个塔防游戏'), '任务预览显示解析后的真实值')
assert(taskPreview.querySelector('li') && taskPreview.querySelector('strong'), '任务预览按 Markdown 渲染（列表/粗体）')
taskPreview.onclick()
const taskModal = document.body.lastChild
const taskTa = taskModal.querySelector('textarea')
assert(!!taskTa && taskTa.value === '{{ Param.task_desc }}', '任务编辑弹窗 textarea 值为原始绑定串')
taskTa.value = '# 新任务\n\n1. 第一步'
;[...taskModal.querySelectorAll('button')].find((b) => b.textContent === '保存').onclick()
assert(written && written.task === '# 新任务\n\n1. 第一步' && written.workdir === '{{ Param.project_dir }}', '任务编辑保存写回完整参数表')
// Studio 收到 onParamsChange 后会重算 paramSources 并重发 props（此处模拟）
w.update({
  ...props,
  params: written,
  paramSources: { ...props.paramSources, task: { kind: 'literal' } },
})
assert(taskPreview.textContent.includes('第一步'), '保存后任务预览更新')
// 恢复 task，供后续用例使用
written = null
w.update({ ...props, params: { ...props.params } })

// running + 等待确认 → 黄灯闪烁；编辑态下运行中参数仍可编辑（写回模板）
w.update({ ...props, status: 'running', execution: { id: 1 } })
const yellow = [...el.querySelectorAll('span')].find((s) => s.style.background === 'rgb(250, 204, 21)')
assert(yellow, 'running 时黄灯亮')
assert(![...el.querySelectorAll('input')].some((i) => i.disabled), '运行中参数输入框保持可编辑（写回模板）')
assert(t.includes || el.textContent.includes('仅影响下次运行'), '运行中编辑有提示')

// 带 transcript 的回放：迷你气泡渲染最近 4 条
const transcript = JSON.stringify([
  { role: 'user', text: 'u1' }, { role: 'assistant', text: 'a1' },
  { role: 'user', text: 'u2' }, { role: 'assistant', text: 'a2' },
  { role: 'user', text: 'u3' }, { role: 'assistant', text: 'a3' },
])
w.update({ ...props, status: 'success', outputs: { transcript, turns: '3', tool_calls: '5' } })
assert(el.textContent.includes('a3') && !el.textContent.includes('a1') && !el.textContent.includes('u1'), '只显示最近 4 条消息')
assert(el.textContent.includes('6 条消息 · 5 次工具调用'), '统计行')

// 编辑 model → onParamsChange 全量写回
const inputs = [...el.querySelectorAll('input')]
const modelInput = inputs[1]
modelInput.value = 'openai/gpt-5'
modelInput.dispatchEvent(new dom.window.Event('change'))
assert(written && written.model === 'openai/gpt-5' && written.workdir === '{{ Param.project_dir }}', 'model 编辑写回完整参数表')

// Markdown 完整渲染（marked GFM + DOMPurify）：打开弹窗检查
const mdTranscript = JSON.stringify([
  { role: 'assistant', text: '# 标题\n**加粗** 和 `code`\n- 项目一\n- 项目二\n> 引用\n[链接](https://example.com)\n```python\nprint(1)\n```\n<script>alert(1)</script>' },
  { role: 'assistant', text: '| 列A | 列B |\n|---|---|\n| 1 | 2 |\n\n~~删除线~~\n\n- [x] 已完成\n- [ ] 待办' },
])
w.update({ ...props, status: 'success', outputs: { transcript: mdTranscript } })
// 点击迷你聊天打开弹窗
const miniEl = [...el.querySelectorAll('div')].find((d) => d.textContent.includes('点击打开对话窗口'))
miniEl.onclick()
const modal = document.body.lastChild
const mt = modal.textContent
assert(modal.querySelector('pre') && modal.querySelector('pre').textContent.includes('print(1)'), 'markdown 代码块')
assert([...modal.querySelectorAll('strong')].some((s) => s.textContent === '加粗'), 'markdown 粗体')
assert(modal.querySelectorAll('li').length === 4, 'markdown 列表（含任务列表项）')
assert(modal.querySelector('blockquote'), 'markdown 引用')
const link = modal.querySelector('a')
assert(link && link.href === 'https://example.com/' && link.target === '_blank', 'markdown 链接（新窗口）')
assert(!modal.querySelector('script') && !mt.includes('alert(1)'), 'XSS 脚本被 DOMPurify 清除')
assert(modal.querySelector('code'), 'markdown 行内 code')
assert(modal.querySelector('table') && modal.querySelectorAll('td').length === 2, 'markdown 表格（GFM）')
assert([...modal.querySelectorAll('del')].some((d) => d.textContent === '删除线'), 'markdown 删除线（GFM）')
const boxes = modal.querySelectorAll('input[type="checkbox"]')
assert(boxes.length === 2 && boxes[0].checked && !boxes[1].checked && [...boxes].every((b) => b.disabled), 'markdown 任务列表（checkbox 禁用）')

w.unmount()
console.log('done')
