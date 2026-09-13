/**
 * pi-vibe-coding 自定义 UI 组件（module 模式，ui.apiVersion: 1）
 *
 * 契约：默认导出 mount(el, props) => { update(props), unmount() }
 *
 * 本文件是「源码」，实际加载的是 ui/build.py 打包 vendor（marked + DOMPurify）
 * 后的单文件 ui/node-widget.js；改完本文件执行 `python3 ui/build.py` 重新构建。
 *
 * 功能：
 *  - 红绿灯状态灯：红=failed / 黄=running（等待用户确认时闪烁）/ 绿=success，未点亮为灰
 *  - 参数区：工作目录 / 模型（单行输入）；任务参数为 Markdown 渲染预览，点击弹出编辑框
 *    （弹窗内编辑原始绑定串/文本，保存写回 config.params）。带来源标注（⚡ 流水线参数
 *    显示真实值）。Studio 编辑态（含运行中）均可编辑——运行中修改写回流水线模板，
 *    仅影响下次运行；回放态（查看历史执行）onParamsChange 缺省 → 只读
 *  - 运行时信息：git 分支 / pi 会话 ID（一键复制终端恢复命令），有数据才显示
 *  - 迷你聊天预览：微缩气泡显示最近 4 条消息 + 提问/思考实时指示，点击打开对话弹窗
 *  - 聊天弹窗：完整对话气泡，Markdown 完整渲染（marked GFM：标题/列表/表格/任务列表/
 *    删除线/代码块/引用/链接/图片等，DOMPurify 防 XSS，链接新窗口）+ 输入交互
 *    （running 时可用），「完成任务」「中止」
 *  - auto_finish 模式：pi 回合结束自动置成功；pi 调 ask_user 工具提问时
 *    弹出提问卡片等待回答（选项按钮/自由输入），回答后 pi 继续
 *
 * 交互通道：节点运行期间，入口脚本在本机起 HTTP 桥并在执行日志打印
 *   VIBE_BRIDGE url=http://127.0.0.1:<port> token=<token>
 * 本组件通过 Studio 执行日志 API（同源 cookie 认证）解析该行获得桥地址，
 * 之后直接轮询桥接口 /state 并 POST /prompt|finish|abort。
 * 节点非 running 时降级为只读模式（数据源为 outputs.transcript）。
 */

const STATUS_META = {
  running: { color: '#facc15', label: '运行中' },
  success: { color: '#34d399', label: '成功' },
  failed: { color: '#fb7185', label: '失败' },
  skipped: { color: '#475569', label: '跳过' },
  idle: { color: '#64748b', label: '空闲' },
}

const BRIDGE_RE = /VIBE_BRIDGE\s+url=(\S+)\s+token=(\S+)/

// 注入一次：黄灯闪烁动画 + .vibe-md（marked 渲染产物）的暗色主题样式
const WIDGET_STYLE_ID = 'vibe-widget-style'
const WIDGET_CSS = `
@keyframes vibe-blink{0%,100%{opacity:1}50%{opacity:0.15}}
.vibe-md{white-space:normal;word-break:break-word;font-size:inherit;line-height:1.6}
.vibe-md>*:first-child{margin-top:0}
.vibe-md>*:last-child{margin-bottom:0}
.vibe-md h1,.vibe-md h2,.vibe-md h3,.vibe-md h4,.vibe-md h5,.vibe-md h6{margin:8px 0 3px;font-weight:600;line-height:1.4}
.vibe-md h1{font-size:16px}.vibe-md h2{font-size:14px}.vibe-md h3{font-size:13px}
.vibe-md h4,.vibe-md h5,.vibe-md h6{font-size:12px}
.vibe-md p{margin:4px 0}
.vibe-md pre{background:rgba(0,0,0,0.35);border-radius:7px;padding:8px 10px;margin:5px 0;overflow:auto;white-space:pre-wrap;word-break:break-all;color:rgba(255,255,255,0.85)}
.vibe-md code{font-family:ui-monospace,Menlo,monospace;font-size:0.92em}
.vibe-md :not(pre)>code{background:rgba(0,0,0,0.3);border-radius:4px;padding:1px 5px}
.vibe-md ul,.vibe-md ol{margin:4px 0;padding-left:20px}
.vibe-md li{margin:2px 0}
.vibe-md li>ul,.vibe-md li>ol{margin:1px 0}
.vibe-md li input[type=checkbox]{margin:0 5px 0 -14px;vertical-align:middle}
.vibe-md blockquote{border-left:2px solid rgba(255,255,255,0.25);padding:1px 0 1px 9px;margin:5px 0;color:rgba(255,255,255,0.65)}
.vibe-md a{color:#60a5fa;text-decoration:underline}
.vibe-md hr{border:none;border-top:1px solid rgba(255,255,255,0.12);margin:7px 0}
.vibe-md table{border-collapse:collapse;margin:6px 0;font-size:0.92em}
.vibe-md th,.vibe-md td{border:1px solid rgba(255,255,255,0.18);padding:3px 8px}
.vibe-md th{background:rgba(255,255,255,0.06)}
.vibe-md img{max-width:100%;border-radius:6px}
.vibe-md del{opacity:0.6}
.vibe-md summary{cursor:pointer}
`

export default function mount(el, props) {
  let cur = props || {}
  let bridge = null            // { url, token }
  let live = null              // 最近一次 /state 响应
  let lastMsgIndex = 0         // 已收到的消息绝对下标（entry.i + 1）
  let liveMessages = []        // running 期间从桥增量累积的消息
  let modalEl = null
  let taskModalEl = null
  let msgListEl = null
  let composerEl = null
  let pollTimer = null
  let discoverTimer = null
  let destroyed = false
  let composerInteractive = null  // 上次渲染的交互态，未变化则不重建输入区
  let draft = ''                  // 输入框草稿，轮询重渲染时保留

  /* ---------------- 卡片 DOM ---------------- */

  el.style.cssText = [
    'font-family: system-ui, sans-serif',
    'background: rgba(255,255,255,0.04)',
    'border: 1px solid rgba(255,255,255,0.08)',
    'border-radius: 12px',
    'padding: 10px 12px',
    'font-size: 11px',
    'line-height: 1.6',
    'color: rgba(255,255,255,0.85)',
    'overflow: hidden',
    'box-sizing: border-box',
    'height: 100%',
    'display: flex',
    'flex-direction: column',
    'gap: 4px',
  ].join(';')

  if (!document.getElementById(WIDGET_STYLE_ID)) {
    const st = document.createElement('style')
    st.id = WIDGET_STYLE_ID
    st.textContent = WIDGET_CSS
    document.head.append(st)
  }

  // 头部：红绿灯式三灯并排（红/黄/绿），未点亮为灰色；右侧状态文字
  const header = document.createElement('div')
  header.style.cssText = 'display:flex;align-items:center;gap:5px'

  const LIGHT_OFF = '#475569'
  const LIGHTS = [
    { key: 'red', color: '#fb7185' },
    { key: 'yellow', color: '#facc15' },
    { key: 'green', color: '#34d399' },
  ]
  const lightEls = LIGHTS.map((l) => {
    const s = document.createElement('span')
    s.style.cssText = 'width:10px;height:10px;border-radius:50%;flex-shrink:0;transition:background .3s'
    s.style.background = LIGHT_OFF
    return { key: l.key, color: l.color, style: s.style, el: s }
  })

  const statusLabel = document.createElement('span')
  statusLabel.style.cssText = 'color:rgba(255,255,255,0.4);margin-left:auto;font-size:10px'

  header.append(...lightEls.map((l) => l.el), statusLabel)

  /* ------- 参数区（来源标注 + 可编辑控件） -------
   * 可编辑性完全由 Studio 决定：编辑态（含流水线运行中）onParamsChange 存在 → 可编辑，
   * 改动写回流水线模板并持久化；回放态（历史执行快照）onParamsChange 缺省 → 只读。
   * 运行中修改只影响下次运行（当前执行用的是启动时物化的快照），UI 以提示说明。 */

  const editable = () => typeof cur.onParamsChange === 'function'
  const editHint = () => (cur.status === 'running'
    ? '（节点运行中：修改写回流水线模板，仅影响下次运行）'
    : '')
  const setParam = (key, value) => {
    if (!editable()) return
    const params = { ...(cur.params || {}), [key]: String(value) }
    cur = { ...cur, params }
    cur.onParamsChange(params)
  }

  const refreshers = []
  const INPUT_CSS = [
    'width:100%', 'background:rgba(99,102,241,0.08)', 'border:1px solid rgba(99,102,241,0.25)',
    'border-radius:6px', 'padding:4px 7px', 'font-size:10px', 'color:rgba(165,180,252,0.95)',
    'outline:none', 'box-sizing:border-box', 'font-family:ui-monospace,Menlo,monospace',
  ].join(';')

  // 字段标注：参数中文名 + 绑定来源（⚡ 流水线参数 / 🔗 上游节点 / ✏️ 自定义值）
  const captionOf = (key, label, hint) => {
    const src = (cur.paramSources || {})[key]
    if (src && src.kind === 'workflow') {
      return {
        text: `${label} · ⚡ 流水线参数 · ${src.paramName || ''}` + (src.paramValue !== undefined ? ` = ${src.paramValue}` : '（未定义）'),
        color: 'rgba(251,191,36,0.85)',
      }
    }
    if (src && src.kind === 'node') {
      return {
        text: `${label} · 🔗 ${src.nodeName || src.nodeId || ''} · ${src.field || ''}` + (src.runtimeValue !== undefined ? ` = ${src.runtimeValue}` : ''),
        color: 'rgba(34,211,238,0.8)',
      }
    }
    return { text: `${label} · ✏️ 自定义值${hint ? `（${hint}）` : ''}`, color: 'rgba(165,180,252,0.75)' }
  }

  const paramField = (key, label, { hint = '' } = {}) => {
    const wrap = document.createElement('div')
    const caption = document.createElement('div')
    caption.style.cssText = 'font-size:9px;margin-bottom:2px;word-break:break-all;line-height:1.4'
    const ctl = document.createElement('input')
    ctl.style.cssText = INPUT_CSS
    ctl.type = 'text'
    ctl.spellcheck = false
    ctl.addEventListener('change', () => setParam(key, ctl.value.trim()))
    const sync = () => {
      const c = captionOf(key, label, hint)
      caption.textContent = c.text + (editable() ? editHint() : '（只读）')
      caption.style.color = c.color
      ctl.disabled = !editable()
      ctl.style.opacity = editable() ? '1' : '0.7'
      ctl.title = editable()
        ? `参数绑定：输入普通值解除绑定；输入 {{ Param.xxx }} 或 {{ 节点.字段 }} 重新绑定${cur.status === 'running' ? '；运行中修改仅影响下次运行' : ''}`
        : '回放态只读（查看历史执行快照）'
      if (document.activeElement !== ctl) ctl.value = rawParam(key)
    }
    sync()
    refreshers.push(sync)
    wrap.append(caption, ctl)
    return wrap
  }

  // 任务参数：Markdown 渲染预览（显示解析后的真实值），点击弹出编辑框
  const taskField = (() => {
    const wrap = document.createElement('div')
    const caption = document.createElement('div')
    caption.style.cssText = 'font-size:9px;margin-bottom:2px;word-break:break-all;line-height:1.4'
    const preview = document.createElement('div')
    preview.style.cssText = [
      'background:rgba(99,102,241,0.08)', 'border:1px solid rgba(99,102,241,0.25)',
      'border-radius:6px', 'padding:5px 8px', 'font-size:10px', 'cursor:pointer',
      'max-height:66px', 'overflow:hidden', 'min-height:22px', 'box-sizing:border-box',
    ].join(';')
    preview.onclick = () => openTaskEditor()
    const sync = () => {
      const c = captionOf('task', '任务')
      caption.textContent = c.text + (editable() ? editHint() : '（只读）')
      caption.style.color = c.color
      preview.style.opacity = editable() ? '1' : '0.85'
      preview.title = editable() ? '点击查看/编辑任务（Markdown 预览，点击弹窗编辑）' : '点击查看任务详情'
      preview.textContent = ''
      const val = paramValue('task')
      if (val.trim()) {
        preview.append(renderMarkdown(val))
      } else {
        const ph = document.createElement('span')
        ph.style.cssText = 'color:rgba(165,180,252,0.45);font-style:italic'
        ph.textContent = editable() ? '点击填写任务描述（支持 Markdown）…' : '（未设置任务）'
        preview.append(ph)
      }
    }
    sync()
    refreshers.push(sync)
    wrap.append(caption, preview)
    return wrap
  })()

  // 任务编辑弹窗：编辑态为 textarea（原始绑定串），回放态为完整 Markdown 只读视图
  function openTaskEditor() {
    if (taskModalEl) return
    const canEdit = editable()

    const overlay = document.createElement('div')
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'background:rgba(0,0,0,0.65)', 'z-index:10000',
      'display:flex', 'align-items:center', 'justify-content:center',
    ].join(';')
    const close = () => { taskModalEl = null; overlay.remove() }
    overlay.onclick = (e) => { if (e.target === overlay) close() }

    const dialog = document.createElement('div')
    dialog.style.cssText = [
      'width:min(680px,92vw)', 'max-height:min(560px,86vh)', 'background:#0f172a',
      'border:1px solid rgba(255,255,255,0.12)', 'border-radius:14px',
      'display:flex', 'flex-direction:column', 'overflow:hidden',
      'font-family:system-ui,sans-serif', 'color:rgba(255,255,255,0.85)', 'font-size:12px',
      'box-shadow:0 20px 60px rgba(0,0,0,0.5)',
    ].join(';')

    const head = document.createElement('div')
    head.style.cssText = [
      'padding:10px 14px', 'border-bottom:1px solid rgba(255,255,255,0.08)',
      'display:flex', 'align-items:center', 'gap:8px', 'flex-shrink:0',
    ].join(';')
    const title = document.createElement('strong')
    title.textContent = canEdit ? '编辑任务' : '任务详情'
    title.style.fontSize = '13px'
    const srcCap = document.createElement('span')
    srcCap.style.cssText = 'color:rgba(255,255,255,0.4);font-size:10px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
    srcCap.textContent = captionOf('task', '任务').text
    const closeBtn = document.createElement('button')
    closeBtn.textContent = '✕'
    closeBtn.style.cssText = btnStyle('transparent') + ';font-size:14px'
    closeBtn.onclick = close
    head.append(title, srcCap, closeBtn)

    const body = document.createElement('div')
    body.style.cssText = 'flex:1;overflow-y:auto;padding:12px 14px'

    const foot = document.createElement('div')
    foot.style.cssText = [
      'padding:9px 14px', 'border-top:1px solid rgba(255,255,255,0.08)',
      'display:flex', 'align-items:center', 'gap:8px', 'flex-shrink:0',
    ].join(';')
    const hint = document.createElement('span')
    hint.style.cssText = 'color:rgba(255,255,255,0.35);font-size:10px;flex:1;line-height:1.5'

    if (canEdit) {
      const ta = document.createElement('textarea')
      ta.value = rawParam('task')
      ta.rows = 12
      ta.spellcheck = false
      ta.placeholder = '任务描述（支持 Markdown）…\n参数绑定：{{ Param.xxx }} 或 {{ 节点.字段 }}'
      ta.style.cssText = [
        'width:100%', 'box-sizing:border-box', 'background:rgba(255,255,255,0.06)',
        'border:1px solid rgba(255,255,255,0.15)', 'border-radius:8px',
        'color:rgba(255,255,255,0.9)', 'font-size:12px', 'padding:8px 10px',
        'resize:vertical', 'outline:none', 'font-family:ui-monospace,Menlo,monospace',
        'line-height:1.6', 'min-height:200px',
      ].join(';')
      body.append(ta)
      hint.textContent = '支持 Markdown；输入 {{ Param.xxx }} 绑定流水线参数' + editHint()
      const saveBtn = document.createElement('button')
      saveBtn.textContent = '保存'
      saveBtn.style.cssText = btnStyle('#2563eb')
      saveBtn.onclick = () => { setParam('task', ta.value); close() }
      const cancelBtn = document.createElement('button')
      cancelBtn.textContent = '取消'
      cancelBtn.style.cssText = btnStyle('#1e293b')
      cancelBtn.onclick = close
      foot.append(hint, cancelBtn, saveBtn)
      setTimeout(() => ta.focus(), 0)
    } else {
      const view = document.createElement('div')
      const val = paramValue('task')
      if (val.trim()) view.append(renderMarkdown(val))
      else {
        view.style.cssText = 'color:rgba(255,255,255,0.35)'
        view.textContent = '（未设置任务）'
      }
      body.append(view)
      const closeBtn2 = document.createElement('button')
      closeBtn2.textContent = '关闭'
      closeBtn2.style.cssText = btnStyle('#1e293b')
      closeBtn2.onclick = close
      foot.append(hint, closeBtn2)
    }

    dialog.append(head, body, foot)
    overlay.append(dialog)
    document.body.append(overlay)
    taskModalEl = overlay
  }

  const paramsBox = document.createElement('div')
  paramsBox.style.cssText = 'display:flex;flex-direction:column;gap:5px'
  paramsBox.append(
    paramField('workdir', '工作目录'),
    paramField('model', '模型', { hint: '留空用 pi 默认模型' }),
    taskField,
  )

  /* ------- 运行时信息（分支/会话，有数据才显示） ------- */

  const infoBox = document.createElement('div')
  infoBox.style.cssText = 'color:rgba(255,255,255,0.5);display:flex;flex-direction:column;gap:1px'

  const branchLine = document.createElement('div')
  const sessionLine = document.createElement('div')
  sessionLine.style.cssText = 'display:flex;align-items:center;gap:4px'
  const sessionText = document.createElement('span')
  sessionText.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
  const copyBtn = document.createElement('button')
  copyBtn.textContent = '复制恢复命令'
  copyBtn.title = '复制 pi 终端恢复会话命令'
  copyBtn.style.cssText = [
    'background:rgba(255,255,255,0.08)', 'border:none', 'border-radius:4px',
    'color:rgba(255,255,255,0.6)', 'font-size:9px', 'padding:1px 5px',
    'cursor:pointer', 'flex-shrink:0',
  ].join(';')
  copyBtn.onclick = (e) => {
    e.stopPropagation()
    const cmd = resumeCommand()
    if (!cmd) return
    navigator.clipboard?.writeText(cmd)
    copyBtn.textContent = '已复制'
    setTimeout(() => { copyBtn.textContent = '复制恢复命令' }, 1500)
  }
  sessionLine.append(sessionText, copyBtn)

  infoBox.append(branchLine, sessionLine)

  /* ------- 迷你聊天预览（最近 4 条，点击打开对话窗口） ------- */

  const mini = document.createElement('div')
  mini.style.cssText = [
    'background:rgba(255,255,255,0.05)', 'border:1px solid rgba(255,255,255,0.08)',
    'border-radius:8px', 'padding:6px', 'cursor:pointer', 'flex:1',
    'overflow:hidden', 'min-height:60px', 'display:flex', 'flex-direction:column', 'gap:4px',
  ].join(';')
  const miniMsgs = document.createElement('div')
  miniMsgs.style.cssText = 'flex:1;overflow:hidden;display:flex;flex-direction:column;gap:4px;justify-content:flex-end'
  const miniHint = document.createElement('div')
  miniHint.style.cssText = 'text-align:center;color:rgba(255,255,255,0.3);font-size:9px;flex-shrink:0'
  miniHint.textContent = '💬 点击打开对话窗口'
  mini.append(miniMsgs, miniHint)
  mini.onclick = () => openModal()

  const statsLine = document.createElement('div')
  statsLine.style.cssText = 'color:rgba(255,255,255,0.3);font-size:10px'

  el.append(header, paramsBox, infoBox, mini, statsLine)

  /* ---------------- 数据源 ---------------- */

  function resumeCommand() {
    if (live && live.resume_command) return live.resume_command
    return (cur.outputs && cur.outputs.resume_command) || ''
  }

  function outputMessages() {
    try {
      return JSON.parse((cur.outputs && cur.outputs.transcript) || '[]')
    } catch {
      return []
    }
  }

  function messages() {
    return bridge && liveMessages.length ? liveMessages : outputMessages()
  }

  function info() {
    const o = cur.outputs || {}
    return {
      workdir: (live && live.workdir) || o.workdir || paramValue('workdir') || '—',
      branch: (live && live.branch) || o.branch || '',
      sessionId: (live && live.session_id) || o.session_id || '',
      task: (live && live.task) || o.summary || paramValue('task') || '',
      turns: live ? live.turns : (o.turns || '0'),
      toolCalls: live ? live.tool_calls : (o.tool_calls || '0'),
      total: live ? live.total : outputMessages().length,
    }
  }

  function rawParam(name) {
    const v = (cur.params || {})[name]
    return typeof v === 'string' ? v : ''
  }

  // 参数显示值解析：优先用 props.paramSources 还原绑定来源的真实值，
  // 避免把 {{ Param.xxx }} 原始模板串直接展示给用户；
  //   workflow → 流水线参数当前值（paramValue，随参数面板实时更新）
  //   node     → 上游节点运行时输出（runtimeValue，执行中/回放时下发）
  //   literal / 无 paramSources → 回退原始绑定串
  function paramValue(name) {
    const raw = rawParam(name)
    const src = (cur.paramSources || {})[name]
    if (src && src.kind === 'workflow') {
      return src.paramValue !== undefined ? String(src.paramValue) : raw
    }
    if (src && src.kind === 'node') {
      return src.runtimeValue !== undefined ? String(src.runtimeValue) : raw
    }
    return raw
  }


  /* ---------------- 桥发现与轮询 ---------------- */

  async function discover() {
    if (destroyed || bridge || discoveringBusy) return
    if (!cur.execution || !cur.execution.id) return
    discoveringBusy = true
    try {
      const r = await fetch(
        `/api/v1/executions/${cur.execution.id}/logs?node_id=${encodeURIComponent(cur.nodeId)}&limit=200`,
        { headers: { Accept: 'application/json' } },
      )
      const j = await r.json()
      const items = (j.data && j.data.items) || []
      for (const item of items) {
        const m = (item.message || '') + '\n' + (item.output || '')
        const hit = m.match(BRIDGE_RE)
        if (hit) {
          const u = new URL(hit[1])
          // 桥与 Studio server 同机：用当前页面主机名替换，兼容局域网访问
          u.hostname = location.hostname
          bridge = { url: u.origin, token: hit[2] }
          startPolling()
          break
        }
      }
    } catch {
      /* 下轮重试 */
    } finally {
      discoveringBusy = false
    }
  }
  let discoveringBusy = false

  function startPolling() {
    if (pollTimer || destroyed) return
    pollTimer = setInterval(pollState, 1500)
    pollState()
  }

  async function pollState() {
    if (destroyed || !bridge) return
    try {
      const r = await fetch(`${bridge.url}/state?since=${lastMsgIndex}`, {
        headers: { 'X-Vibe-Token': bridge.token },
      })
      if (!r.ok) return
      const s = await r.json()
      live = s
      for (const m of s.messages || []) {
        if (m.i >= lastMsgIndex) {
          liveMessages.push(m)
          lastMsgIndex = m.i + 1
        }
      }
      if (s.dropped > 0 && liveMessages.length && liveMessages[0].i < s.dropped) {
        liveMessages = liveMessages.filter((m) => m.i >= s.dropped)
      }
      render()
      renderModalMessages()
      // 节点结束后桥会退出；停止轮询由 status 变化驱动
      if (s.finished || s.aborted || s.error) {
        setTimeout(() => { /* 等 props 状态翻转后自然停止 */ }, 0)
      }
    } catch {
      // 桥不可达（节点已结束）→ 停止轮询，保持只读
      stopPolling()
    }
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  }

  /* ---------------- 卡片渲染 ---------------- */

  function render() {
    const meta = STATUS_META[cur.status] || STATUS_META.idle
    // 红绿灯：failed→红 / running→黄（等待用户确认时闪烁）/ success→绿 / 其余全灰
    const waiting = cur.status === 'running' && !!(live && (live.pending_question || live.waiting_answer))
    const lit = cur.status === 'failed' ? 'red'
      : cur.status === 'running' ? 'yellow'
      : cur.status === 'success' ? 'green' : null
    for (const l of lightEls) {
      const on = l.key === lit
      l.style.background = on ? l.color : LIGHT_OFF
      l.style.boxShadow = on ? `0 0 6px ${l.color}` : 'none'
      l.style.animation = on && l.key === 'yellow' && waiting ? 'vibe-blink 1s ease-in-out infinite' : ''
    }
    statusLabel.textContent = meta.label

    // 参数控件同步（来源标注/禁用态/未聚焦时刷新值）
    for (const f of refreshers) f()

    // 运行时信息：有数据才显示
    const i = info()
    branchLine.style.display = i.branch ? '' : 'none'
    if (i.branch) branchLine.textContent = `🌿 ${i.branch}`
    const cmd = resumeCommand()
    sessionLine.style.display = i.sessionId || cmd ? '' : 'none'
    sessionText.textContent = i.sessionId ? `🔑 ${i.sessionId.slice(0, 8)}…` : '🔑 —'
    sessionText.title = i.sessionId
    copyBtn.style.display = cmd ? '' : 'none'

    renderMini()

    statsLine.textContent = `${i.total} 条消息 · ${i.toolCalls} 次工具调用${i.turns ? ` · ${i.turns} 轮` : ''}`
  }

  /* ---------------- 迷你聊天预览（最近 4 条，微缩气泡） ---------------- */

  const MINI_BUBBLE_BASE = [
    'border-radius:8px', 'padding:3px 7px', 'max-width:88%', 'font-size:10px',
    'line-height:1.45', 'word-break:break-word', 'white-space:pre-wrap',
    'display:-webkit-box', '-webkit-line-clamp:2', '-webkit-box-orient:vertical', 'overflow:hidden',
  ].join(';')

  function miniBubble(text, align, bg) {
    const row = document.createElement('div')
    row.style.cssText = `display:flex;justify-content:${align}`
    const b = document.createElement('div')
    b.style.cssText = MINI_BUBBLE_BASE + `;background:${bg}`
    b.textContent = text
    row.append(b)
    return row
  }

  function renderMini() {
    miniMsgs.textContent = ''
    const msgs = messages()
    const recent = msgs.slice(-4)
    if (!recent.length) {
      const empty = document.createElement('div')
      empty.style.cssText = 'color:rgba(255,255,255,0.3);text-align:center;font-size:10px;margin:auto'
      empty.textContent = cur.status === 'running' ? '等待 pi 响应…' : '暂无对话记录'
      miniMsgs.append(empty)
    }
    for (const m of recent) {
      if (m.role === 'user') {
        miniMsgs.append(miniBubble(m.text || '', 'flex-end', 'rgba(37,99,235,0.35)'))
      } else if (m.role === 'assistant') {
        const toolNames = (m.tools || []).map((t) => `🔧${t.name}`).join(' ')
        const text = (m.text || '') + (toolNames ? `${m.text ? '\n' : ''}${toolNames}` : '')
        miniMsgs.append(miniBubble(text || '[工具调用]', 'flex-start', 'rgba(255,255,255,0.07)'))
      } else if (m.role === 'tool') {
        miniMsgs.append(miniBubble(`${m.isError ? '✗' : '✓'} ${m.name || 'tool'}`, 'flex-start', 'rgba(255,255,255,0.04)'))
      }
      // 其余 role（system 等）在预览中忽略
    }

    // 实时指示：提问卡片 / 思考中 / 等待回答
    const pq = live && live.pending_question
    if (pq) {
      const card = document.createElement('div')
      card.style.cssText = [
        'background:rgba(37,99,235,0.18)', 'border:1px solid rgba(96,165,250,0.45)',
        'border-radius:8px', 'padding:4px 8px', 'font-size:10px', 'line-height:1.45',
        'display:-webkit-box', '-webkit-line-clamp:2', '-webkit-box-orient:vertical', 'overflow:hidden',
      ].join(';')
      card.textContent = (pq.kind === 'confirm' ? '🔔 请求确认：' : '🔔 提问：') + (pq.question || '')
      miniMsgs.append(card)
    } else if (live && live.busy) {
      const b = document.createElement('div')
      b.style.cssText = 'color:rgba(250,204,21,0.7);font-size:9px;padding-left:2px'
      b.textContent = '⏳ pi 正在思考 / 执行…'
      miniMsgs.append(b)
    } else if (live && live.waiting_answer) {
      const w = document.createElement('div')
      w.style.cssText = 'color:rgba(52,211,153,0.8);font-size:9px;padding-left:2px'
      w.textContent = '❓ pi 向你提问，点击打开对话窗口回答…'
      miniMsgs.append(w)
    }
  }

  /* ---------------- 聊天弹窗 ---------------- */

  function openModal() {
    if (modalEl) return

    const overlay = document.createElement('div')
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'background:rgba(0,0,0,0.6)', 'z-index:9999',
      'display:flex', 'align-items:center', 'justify-content:center',
    ].join(';')
    overlay.onclick = (e) => { if (e.target === overlay) closeModal() }

    const dialog = document.createElement('div')
    dialog.style.cssText = [
      'width:min(760px,92vw)', 'height:min(600px,86vh)', 'background:#0f172a',
      'border:1px solid rgba(255,255,255,0.12)', 'border-radius:14px',
      'display:flex', 'flex-direction:column', 'overflow:hidden',
      'font-family:system-ui,sans-serif', 'color:rgba(255,255,255,0.85)',
      'box-shadow:0 20px 60px rgba(0,0,0,0.5)',
    ].join(';')

    // 头部
    const head = document.createElement('div')
    head.style.cssText = [
      'padding:10px 14px', 'border-bottom:1px solid rgba(255,255,255,0.08)',
      'display:flex', 'align-items:center', 'gap:8px', 'flex-shrink:0',
    ].join(';')
    const headDot = document.createElement('span')
    const m = STATUS_META[cur.status] || STATUS_META.idle
    headDot.style.cssText = `width:9px;height:9px;border-radius:50%;background:${m.color}`
    const headTitle = document.createElement('strong')
    headTitle.textContent = 'Vibe Coding 会话'
    headTitle.style.fontSize = '13px'
    const headInfo = document.createElement('span')
    headInfo.style.cssText = 'color:rgba(255,255,255,0.4);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1'
    const i0 = info()
    headInfo.textContent = `${i0.workdir}${i0.branch ? ' · ' + i0.branch : ''}${i0.sessionId ? ' · ' + i0.sessionId.slice(0, 8) + '…' : ''}`
    headInfo.title = `${i0.workdir} ${i0.sessionId}`
    const copyBtn2 = document.createElement('button')
    copyBtn2.textContent = '复制终端恢复命令'
    copyBtn2.style.cssText = btnStyle('#1e293b')
    copyBtn2.onclick = () => {
      const cmd = resumeCommand()
      if (!cmd) return
      navigator.clipboard?.writeText(cmd)
      copyBtn2.textContent = '已复制'
      setTimeout(() => { copyBtn2.textContent = '复制终端恢复命令' }, 1500)
    }
    const closeBtn = document.createElement('button')
    closeBtn.textContent = '✕'
    closeBtn.style.cssText = btnStyle('transparent') + ';font-size:14px'
    closeBtn.onclick = closeModal
    head.append(headDot, headTitle, headInfo, copyBtn2, closeBtn)

    // 消息列表
    msgListEl = document.createElement('div')
    msgListEl.style.cssText = 'flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:8px'

    // 输入区
    composerEl = document.createElement('div')
    composerEl.style.cssText = [
      'border-top:1px solid rgba(255,255,255,0.08)', 'padding:10px 14px',
      'display:flex', 'flex-direction:column', 'gap:8px', 'flex-shrink:0',
    ].join(';')

    dialog.append(head, msgListEl, composerEl)
    overlay.append(dialog)
    document.body.append(overlay)
    modalEl = overlay

    // 弹窗重开：composerEl 是新 DOM，必须重置缓存强制重建输入区
    composerInteractive = null
    renderComposer()
    renderModalMessages()
    if (bridge) startPolling()
  }

  function btnStyle(bg) {
    return [
      `background:${bg}`, 'border:1px solid rgba(255,255,255,0.12)', 'border-radius:6px',
      'color:rgba(255,255,255,0.75)', 'font-size:11px', 'padding:4px 10px', 'cursor:pointer',
    ].join(';')
  }

  function closeModal() {
    if (modalEl) { modalEl.remove(); modalEl = null; msgListEl = null; composerEl = null }
  }

  function renderComposer() {
    if (!composerEl) return
    const interactive = cur.status === 'running' && bridge && live && !live.finished && !live.aborted && !live.error
    // 交互态未变化时保持现有 DOM（避免轮询重建输入框导致正在输入的内容被清空）；
    // 提问/等待回答态变化时重建以更新提示（草稿由 draft 保留）
    const pq = interactive && live.pending_question
    const key = interactive ? (pq ? 'ask:' + pq.id : (live.waiting_answer ? 'wait' : 'chat')) : 'off'
    if (key === composerInteractive) return
    composerInteractive = key
    composerEl.textContent = ''

    if (!interactive) {
      const note = document.createElement('div')
      note.style.cssText = 'color:rgba(255,255,255,0.35);font-size:11px;width:100%;text-align:center'
      note.textContent = cur.status === 'running'
        ? '等待交互桥连接…'
        : '会话已结束，只读回放。重跑节点可在同一 workdir 续聊。'
      composerEl.append(note)
      return
    }

    const input = document.createElement('textarea')
    input.placeholder = pq
      ? '输入你的回答…（Enter 发送，Shift+Enter 换行）'
      : live && live.waiting_answer
        ? '❓ pi 向你提问，输入回答…（Enter 发送，Shift+Enter 换行）'
        : '继续对话…（Enter 发送，Shift+Enter 换行）'
    input.rows = 2
    input.value = draft
    input.oninput = () => { draft = input.value }
    input.style.cssText = [
      'flex:1', 'background:rgba(255,255,255,0.06)', 'border:1px solid rgba(255,255,255,0.12)',
      'border-radius:8px', 'color:rgba(255,255,255,0.9)', 'font-size:12px',
      'padding:6px 9px', 'resize:none', 'outline:none', 'font-family:inherit',
    ].join(';')

    const sendBtn = document.createElement('button')
    sendBtn.textContent = pq ? '回答' : '发送'
    sendBtn.style.cssText = btnStyle('#2563eb')
    const doSend = async () => {
      const text = input.value.trim()
      if (!text) return
      input.value = ''
      draft = ''
      try {
        if (pq) {
          await fetch(`${bridge.url}/answer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Vibe-Token': bridge.token },
            body: JSON.stringify({ id: pq.id, answer: text }),
          })
        } else {
          await fetch(`${bridge.url}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Vibe-Token': bridge.token },
            body: JSON.stringify({ message: text }),
          })
        }
        pollState()
      } catch { /* 下轮渲染提示 */ }
    }
    sendBtn.onclick = doSend
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend() }
    }

    // ask_user 提问：渲染选项按钮（confirm 无选项时默认 确认/拒绝）
    if (pq) {
      const opts = pq.options && pq.options.length
        ? pq.options
        : pq.kind === 'confirm' ? ['确认', '拒绝'] : []
      if (opts.length) {
        const optRow = document.createElement('div')
        optRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;width:100%;margin-bottom:6px'
        for (const opt of opts) {
          const b = document.createElement('button')
          b.textContent = opt
          b.style.cssText = btnStyle('#1e293b')
          b.onclick = async () => {
            // 即时反馈：禁用全部选项并标记已选，避免重复提交/误以为没点上
            const all = [...optRow.querySelectorAll('button')]
            for (const ob of all) { ob.disabled = true; ob.style.opacity = '0.55' }
            b.textContent = `${opt} ✓`
            b.style.opacity = '1'
            try {
              const r = await fetch(`${bridge.url}/answer`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Vibe-Token': bridge.token },
                body: JSON.stringify({ id: pq.id, answer: opt }),
              })
              if (!r.ok) throw new Error('answer rejected')
              pollState()
            } catch {
              // 提交失败：恢复可点，下轮渲染提示
              for (const ob of all) { ob.disabled = false; ob.style.opacity = '1' }
              b.textContent = opt
            }
          }
          optRow.append(b)
        }
        composerEl.append(optRow)
      }
    }

    const finishBtn = document.createElement('button')
    finishBtn.textContent = '✅ 完成'
    finishBtn.title = '结束会话，节点置为成功，流水线继续'
    finishBtn.style.cssText = btnStyle('#065f46')
    finishBtn.onclick = async () => {
      if (!confirm('结束当前 pi 会话并将节点标记为成功？')) return
      try {
        await fetch(`${bridge.url}/finish`, { method: 'POST', headers: { 'X-Vibe-Token': bridge.token } })
      } catch { /* 桥可能已退出 */ }
      renderComposer()
    }

    const abortBtn = document.createElement('button')
    abortBtn.textContent = '⛔ 中止'
    abortBtn.title = '终止 pi 进程，节点置为失败'
    abortBtn.style.cssText = btnStyle('#7f1d1d')
    abortBtn.onclick = async () => {
      if (!confirm('中止任务？pi 进程将被终止，节点标记为失败。')) return
      try {
        await fetch(`${bridge.url}/abort`, { method: 'POST', headers: { 'X-Vibe-Token': bridge.token } })
      } catch { /* 桥可能已退出 */ }
      renderComposer()
    }

    const row = document.createElement('div')
    row.style.cssText = 'display:flex;gap:8px;align-items:flex-end;width:100%'
    row.append(input, sendBtn, finishBtn, abortBtn)
    composerEl.append(row)
    input.focus()
  }

  function bubble(contentEl, align, bg) {
    const row = document.createElement('div')
    row.style.cssText = `display:flex;justify-content:${align}`
    const b = document.createElement('div')
    b.style.cssText = [
      `background:${bg}`, 'border-radius:10px', 'padding:7px 11px', 'max-width:82%',
      'font-size:12px', 'word-break:break-word', 'line-height:1.55',
    ].join(';')
    b.append(contentEl)
    row.append(b)
    return row
  }

  /* ---------------- Markdown 渲染（marked GFM + DOMPurify） ----------------
   * 完整 GFM：标题/列表（含嵌套、任务列表）/表格/删除线/代码块（带语言标识）/
   * 引用/分隔线/链接/图片/行内代码/粗斜体/自动链接等。
   * breaks: true —— 聊天语境下单换行即 <br>。
   * 安全：marked 输出经 DOMPurify 消毒（script/事件处理器等被剥离）；
   * 链接统一 target=_blank rel=noopener；任务列表 checkbox 强制 disabled。
   * vendor 缺失/解析异常时降级为转义纯文本（pre-wrap）。 */

  function renderMarkdown(text) {
    const root = document.createElement('div')
    root.className = 'vibe-md'
    const raw = String(text == null ? '' : text)
    try {
      if (typeof __vibeMarked === 'undefined' || typeof __vibePurify === 'undefined' || !__vibePurify) {
        throw new Error('markdown vendor 不可用')
      }
      const html = __vibeMarked.parse(raw, { gfm: true, breaks: true })
      const frag = __vibePurify.sanitize(html, {
        RETURN_DOM_FRAGMENT: true,
        ADD_TAGS: ['input'],
        ADD_ATTR: ['type', 'checked', 'disabled', 'target', 'rel'],
      })
      for (const a of frag.querySelectorAll('a')) {
        a.setAttribute('target', '_blank')
        a.setAttribute('rel', 'noopener noreferrer')
      }
      for (const c of frag.querySelectorAll('input[type="checkbox"]')) {
        c.setAttribute('disabled', '')
      }
      root.append(frag)
    } catch {
      root.style.whiteSpace = 'pre-wrap'
      root.textContent = raw
    }
    return root
  }

  function renderModalMessages() {
    if (!msgListEl) return
    const nearBottom = msgListEl.scrollHeight - msgListEl.scrollTop - msgListEl.clientHeight < 80
    msgListEl.textContent = ''

    const msgs = messages()
    if (!msgs.length) {
      const empty = document.createElement('div')
      empty.style.cssText = 'color:rgba(255,255,255,0.3);text-align:center;margin-top:40px;font-size:12px'
      empty.textContent = '暂无对话记录'
      msgListEl.append(empty)
    }

    for (const m of msgs) {
      if (m.role === 'user') {
        msgListEl.append(bubble(renderMarkdown(m.text || ''), 'flex-end', 'rgba(37,99,235,0.35)'))
      } else if (m.role === 'assistant') {
        const wrap = document.createElement('div')
        if (m.text) wrap.append(renderMarkdown(m.text))
        for (const t of m.tools || []) {
          const chip = document.createElement('div')
          chip.style.cssText = [
            'margin-top:5px', 'font-size:10px', 'color:rgba(255,255,255,0.5)',
            'background:rgba(255,255,255,0.06)', 'border-radius:5px', 'padding:2px 7px',
            'font-family:ui-monospace,monospace', 'overflow:hidden',
            'text-overflow:ellipsis', 'white-space:nowrap',
          ].join(';')
          chip.textContent = `🔧 ${t.name} ${t.args || ''}`
          chip.title = t.args || ''
          wrap.append(chip)
        }
        msgListEl.append(bubble(wrap, 'flex-start', 'rgba(255,255,255,0.07)'))
      } else if (m.role === 'tool') {
        const det = document.createElement('details')
        det.style.cssText = 'max-width:82%;font-size:11px'
        const sum = document.createElement('summary')
        sum.style.cssText = `cursor:pointer;color:${m.isError ? '#fb7185' : 'rgba(255,255,255,0.4)'};font-family:ui-monospace,monospace`
        sum.textContent = `${m.isError ? '✗' : '✓'} ${m.name || 'tool'}`
        const body = document.createElement('pre')
        body.style.cssText = [
          'margin:4px 0 0', 'padding:6px 8px', 'background:rgba(0,0,0,0.3)', 'border-radius:6px',
          'font-size:10px', 'white-space:pre-wrap', 'word-break:break-all',
          'color:rgba(255,255,255,0.55)', 'max-height:180px', 'overflow:auto',
        ].join(';')
        body.textContent = `${m.args ? m.args + '\n---\n' : ''}${m.text || ''}`
        det.append(sum, body)
        const row = document.createElement('div')
        row.style.cssText = 'display:flex;justify-content:flex-start'
        row.append(det)
        msgListEl.append(row)
      } else {
        const row = document.createElement('div')
        row.style.cssText = 'text-align:center;color:rgba(255,255,255,0.35);font-size:10px'
        row.textContent = m.text || ''
        msgListEl.append(row)
      }
    }

    const pqRow = live && live.pending_question
    if (pqRow) {
      const card = document.createElement('div')
      card.style.cssText = [
        'background:rgba(37,99,235,0.18)', 'border:1px solid rgba(96,165,250,0.45)',
        'border-radius:10px', 'padding:9px 12px', 'font-size:12px', 'line-height:1.55',
      ].join(';')
      const tag = document.createElement('div')
      tag.style.cssText = 'color:#93c5fd;font-size:10px;margin-bottom:3px'
      tag.textContent = pqRow.kind === 'confirm' ? '🔔 pi 请求确认' : '🔔 pi 向你提问'
      const q = document.createElement('div')
      q.append(renderMarkdown(pqRow.question || ''))
      card.append(tag, q)
      msgListEl.append(card)
    }

    if (live && live.busy && !pqRow) {
      const busyRow = document.createElement('div')
      busyRow.style.cssText = 'color:rgba(250,204,21,0.7);font-size:11px;padding-left:4px'
      busyRow.textContent = '⏳ pi 正在思考 / 执行…'
      msgListEl.append(busyRow)
    } else if (live && live.waiting_answer) {
      const waitRow = document.createElement('div')
      waitRow.style.cssText = 'color:rgba(52,211,153,0.8);font-size:11px;padding-left:4px'
      waitRow.textContent = '❓ pi 向你提问，等待你的回答…（回答后回合结束会自动完成）'
      msgListEl.append(waitRow)
    }

    if (nearBottom) msgListEl.scrollTop = msgListEl.scrollHeight
    renderComposer()
  }

  /* ---------------- 主流程 ---------------- */

  function syncRunState() {
    if (destroyed) return
    if (cur.status === 'running' && cur.execution) {
      if (!bridge && !discoverTimer) {
        discover()
        discoverTimer = setInterval(() => {
          if (bridge || cur.status !== 'running') {
            clearInterval(discoverTimer); discoverTimer = null
          } else {
            discover()
          }
        }, 2000)
      }
      if (bridge) startPolling()
    } else {
      // 节点不再 running：桥随之退出，停轮询但保留已累积的消息展示
      if (discoverTimer) { clearInterval(discoverTimer); discoverTimer = null }
      stopPolling()
    }
  }

  render()
  syncRunState()

  return {
    update(next) {
      cur = next || {}
      render()
      renderModalMessages()
      syncRunState()
    },
    unmount() {
      destroyed = true
      stopPolling()
      if (discoverTimer) clearInterval(discoverTimer)
      closeModal()
      if (taskModalEl) { taskModalEl.remove(); taskModalEl = null }
      el.textContent = ''
    },
  }
}
