#!/usr/bin/env python3
"""pi-vibe-coding 节点入口（仅 local 执行器）。

驱动本机 pi CLI（--mode rpc）执行 vibe coding 任务，同时起一个本地 HTTP 桥，
向 FlowX Studio 画布组件暴露实时对话状态与交互能力：

  - 节点运行期间保持 running（黄灯），等待用户在弹窗中交互；
  - auto_finish=true（默认）：pi 回合完全结束（agent_settled）后自动判定——
    pi 需要提问/确认时必须调用内置 ask_user 工具（挂起等待弹窗回答）；
    未调用工具但以 ? / ？ 结尾视为提问（兜底）→ 保持 running 等待弹窗回答；
    否则自动置成功（绿灯），流水线继续；
  - auto_finish=false：旧行为，始终等待用户在弹窗点「完成任务」→ 成功；
  - 用户点「中止」/ pi 崩溃 / 超时（默认 48h）→ 节点失败（红灯）；
  - pi 会话持久化在 <workdir>/.pi-vibe/，按 执行实例 × 节点 隔离：
    会话目录为 <workdir>/.pi-vibe/sessions/<节点ID>/，仅同一执行内
    同一节点的重入（execution continue / 重跑）自动 -c 续聊；
    同一执行/全新执行中的其他节点（即使共用 workdir）一律开新会话。

桥接发现：启动后向 stdout 打印一行
  VIBE_BRIDGE url=http://127.0.0.1:<port> token=<token>
画布组件通过 Studio 执行日志 API 解析该行获得桥地址。

环境变量（flowx.json env 注入，VIBE_* 优先，兼容 FLOWX_PARAM_*/裸大写）：
  VIBE_TASK         任务描述（仅首次运行作为首个 prompt）
  VIBE_WORKDIR      pi 工作目录（会话状态存于 <workdir>/.pi-vibe/）
  VIBE_MODEL        可选，透传 --model
  VIBE_TIMEOUT      秒，0 表示不限，默认 172800（48 小时）
  VIBE_BRIDGE_PORT  桥接端口，0 表示由内核自动分配空闲端口（默认，避免并行节点端口冲突）
  VIBE_AUTO_FINISH  true/false，默认 true：pi 回合结束且无提问时自动置成功

运行时注入（flowx 引擎自动提供，无需配置）：
  FLOWX_WORKFLOW_ID  执行实例标识（flowx-studio 中为 exec-<执行ID>），
                     与 FLOWX_NODE_ID 一起用于会话隔离：与按节点划分的
                     execution-id 标记比对，一致才续聊；否则开新会话
  FLOWX_NODE_ID      节点 ID。同一 workdir 被流水线中多个本节点复用时
                     （如方案确认/联调验收都在项目根目录），按节点 ID 划分
                     独立会话目录，避免误续聊其他节点的会话

内置 ask_user 工具：通过 -e 向 pi 加载 ask-user 扩展（源码内嵌于本文件，
运行时写入 <workdir>/.pi-vibe/ask-user-extension.ts），pi 需要用户输入/确认时
调用该工具，工具经桥挂起等待弹窗回答。
"""
import json
import os
import re
import secrets
import shlex
import shutil
import signal
import subprocess
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_MSG_CHARS = 5000    # 单条消息最大字符
MAX_MESSAGES = 1000     # 桥内最多保留条数（环形丢弃最旧）
OUT_MSGS = 100          # 结束后写入 outputs.transcript 的最大条数
OUT_CHARS = 400_000     # outputs.transcript 最大字符

QUESTION_RE = re.compile(r"[?？]\s*$")  # 末条助手回复以问号结尾 → 视为向用户提问（兜底）
AUTO_FINISH_EVENT = threading.Event()   # agent_settled 且无提问 → 自动完成节点

# pi 扩展源码：注册 ask_user 工具，pi 提问/请求确认时调用，经桥挂起等待用户回答。
# 运行时写入 <workdir>/.pi-vibe/ask-user-extension.ts 并以 pi -e 加载。
ASK_USER_EXTENSION = r'''
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const BRIDGE_URL = process.env.VIBE_BRIDGE_URL || "";
const BRIDGE_TOKEN = process.env.VIBE_BRIDGE_TOKEN || "";

const askUserTool = defineTool({
	name: "ask_user",
	label: "Ask User",
	description:
		"Ask the human user a question or request confirmation. This blocks until the user answers in the pipeline UI. " +
		"Use this whenever you need information, a decision, or confirmation from the user — never end your reply text with a question expecting the user to respond.",
	promptSnippet: "Ask the user a blocking question and wait for the answer",
	promptGuidelines: [
		"Use ask_user whenever you need input, a decision, or confirmation from the user; never end your reply text with a question expecting the user to answer.",
		"After the user answers via ask_user, continue the task with the answer; only call ask_user again when genuinely blocked on the user.",
	],
	parameters: Type.Object({
		question: Type.String({ description: "The full question to show the user" }),
		kind: Type.Optional(
			StringEnum(["question", "confirm"], { description: "question = free-form answer; confirm = approval/rejection" }),
		),
		options: Type.Optional(
			Type.Array(Type.String(), { description: "Optional choices presented as buttons; the user may still answer freely" }),
		),
	}),

	async execute(_toolCallId, params, signal) {
		if (!BRIDGE_URL || !BRIDGE_TOKEN) {
			throw new Error("ask_user 不可用：缺少 VIBE_BRIDGE_URL/VIBE_BRIDGE_TOKEN（该工具仅在 FlowX vibe-coding 节点内运行）");
		}
		const payload = JSON.stringify({
			question: params.question,
			kind: params.kind ?? "question",
			options: params.options ?? [],
		});
		// 桥会长时间挂起 /ask 直到用户回答。undici 默认 headersTimeout(300s) 会断开这类
		// 长连接（表现为 fetch failed）——属预期，静默重连即可：桥对同一 question 重挂复用
		// 原问题，用户已提交的答案会被补发，不会因断线丢失。
		for (;;) {
			if (signal?.aborted) throw new Error("提问被取消");
			let resp: Response;
			try {
				resp = await fetch(`${BRIDGE_URL}/ask`, {
					method: "POST",
					headers: { "Content-Type": "application/json", "X-Vibe-Token": BRIDGE_TOKEN },
					body: payload,
					signal,
				});
			} catch {
				if (signal?.aborted) throw new Error("提问被取消");
				await new Promise((r) => setTimeout(r, 2000));
				continue;
			}
			const data = (await resp.json().catch(() => ({}))) as { answer?: string; aborted?: boolean; error?: string };
			if (!resp.ok || data.aborted) {
				throw new Error(data.error || "提问被取消（用户中止或节点结束）");
			}
			return {
				content: [{ type: "text", text: `用户回答：${data.answer}` }],
				details: { question: params.question, answer: data.answer },
			};
		}
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(askUserTool);
}
'''


def param(name, default=""):
    for key in ("VIBE_" + name.upper(), "FLOWX_PARAM_" + name.upper(), name.upper()):
        v = os.environ.get(key)
        if v:
            return v
    return default


def log(msg):
    print(f"[pi-vibe-coding] {msg}", flush=True)


def log_error(msg):
    """写 error 级日志。行首 [flowx:error] 是 flowx 运行时的级别标记约定，
    会被剥离并按 error 级入库，前端据此给出失败提示。"""
    print(f"[flowx:error] [pi-vibe-coding] {msg}", flush=True)


def trunc(text, limit=MAX_MSG_CHARS):
    text = text or ""
    return text if len(text) <= limit else text[:limit] + f"…[截断，原 {len(text)} 字符]"


def git_branch(workdir):
    try:
        r = subprocess.run(
            ["git", "-C", workdir, "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, timeout=5,
        )
        if r.returncode == 0:
            return r.stdout.strip()
        # 无提交的新仓库（unborn HEAD）
        r = subprocess.run(
            ["git", "-C", workdir, "symbolic-ref", "--short", "HEAD"],
            capture_output=True, text=True, timeout=5,
        )
        return r.stdout.strip() if r.returncode == 0 else ""
    except Exception:
        return ""


def text_of_content(content):
    """从 pi 消息 content 数组提取纯文本。"""
    if isinstance(content, str):
        return content
    parts = []
    for item in content or []:
        if isinstance(item, dict) and item.get("type") == "text":
            parts.append(item.get("text", ""))
    return "\n".join(p for p in parts if p)


def tool_calls_of(content):
    """从 assistant 消息 content 数组提取工具调用摘要。"""
    calls = []
    for item in content or []:
        if isinstance(item, dict) and item.get("type") == "toolCall":
            calls.append({
                "name": item.get("name", "?"),
                "args": trunc(json.dumps(item.get("arguments"), ensure_ascii=False), 300),
            })
    return calls


class State:
    def __init__(self, workdir, task, model, auto_finish=True):
        self.lock = threading.Lock()
        self.workdir = workdir
        self.task = task
        self.model = model
        self.auto_finish = auto_finish
        self.branch = git_branch(workdir)
        self.session_id = ""
        self.session_file = ""
        self.resumed = False
        self.messages = []      # [{i, role, text, name?, args?, isError?, tools?, ts}]
        self.dropped = 0
        self._next_i = 0
        self.busy = False
        self.waiting_answer = False  # 兜底规则：pi 以问号收尾，等待用户回答
        self.pending_question = None  # ask_user 工具挂起中的提问 {id,question,kind,options,answer,event}
        self.finished = False   # 用户点了完成
        self.aborted = False    # 用户点了中止
        self.error = None       # pi 崩溃/超时原因
        self.turns = 0
        self.tool_calls = 0
        self._pending_tools = {}  # toolCallId -> {name, args}

    def add(self, role, text="", name="", args="", is_error=False, tools=None):
        with self.lock:
            entry = {
                "i": self._next_i,
                "role": role,
                "text": trunc(text),
                "ts": int(time.time() * 1000),
            }
            if name:
                entry["name"] = name
            if args:
                entry["args"] = trunc(args, 300)
            if is_error:
                entry["isError"] = True
            if tools:
                entry["tools"] = tools
            self._next_i += 1
            self.messages.append(entry)
            if len(self.messages) > MAX_MESSAGES:
                overflow = len(self.messages) - MAX_MESSAGES
                self.messages = self.messages[overflow:]
                self.dropped += overflow

    def snapshot(self, since):
        with self.lock:
            offset = max(0, since - self.dropped)
            msgs = self.messages[offset:]
            pq = self.pending_question
            pending = {k: pq[k] for k in ("id", "question", "kind", "options")} if pq else None
            return {
                "busy": self.busy,
                "waiting_answer": self.waiting_answer,
                "pending_question": pending,
                "auto_finish": self.auto_finish,
                "finished": self.finished,
                "aborted": self.aborted,
                "error": self.error,
                "session_id": self.session_id,
                "session_file": self.session_file,
                "session_dir": os.path.dirname(self.session_file) if self.session_file else "",
                "workdir": self.workdir,
                "branch": self.branch,
                "task": self.task,
                "model": self.model,
                "resumed": self.resumed,
                "dropped": self.dropped,
                "total": self.dropped + len(self.messages),
                "turns": self.turns,
                "tool_calls": self.tool_calls,
                "messages": msgs,
                "resume_command": resume_command(self.session_file, self.workdir),
            }


def resume_command(session_file, workdir=""):
    if not session_file:
        return ""
    # pi -c（findMostRecentSession）按会话 header 的 cwd 匹配「当前终端目录」，
    # 不在 workdir 下执行会匹配不到任何会话而开新空会话（历史为空），
    # 因此命令必须先 cd 进 workdir。
    cmd = f"pi --session-dir {shlex.quote(os.path.dirname(session_file))} -c"
    if workdir:
        cmd = f"cd {shlex.quote(workdir)} && {cmd}"
    return cmd


class PiRpc:
    """pi --mode rpc 子进程封装。"""

    def __init__(self, workdir, sessions_dir, model, resumed, on_event, extra_args=None, extra_env=None):
        args = ["pi", "--mode", "rpc", "--session-dir", sessions_dir]
        if resumed:
            args.append("-c")
        if model:
            args += ["--model", model]
        args += list(extra_args or [])
        env = dict(os.environ)
        env.update(extra_env or {})
        log(f"启动 pi: {' '.join(args)} (cwd={workdir})")
        self.proc = subprocess.Popen(
            args,
            cwd=workdir,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
        self._send_lock = threading.Lock()
        self._reader = threading.Thread(target=self._read_loop, args=(on_event,), daemon=True)
        self._reader.start()

    def send(self, obj):
        line = json.dumps(obj, ensure_ascii=False)
        with self._send_lock:
            try:
                self.proc.stdin.write(line + "\n")
                self.proc.stdin.flush()
                return True
            except (BrokenPipeError, ValueError) as e:
                log(f"写入 pi stdin 失败: {e}")
                return False

    def terminate(self):
        try:
            self.proc.terminate()
            self.proc.wait(timeout=5)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass

    def poll(self):
        return self.proc.poll()

    def _read_loop(self, on_event):
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            try:
                on_event(ev)
            except Exception as e:
                log(f"事件处理异常: {e}")


class BridgeHandler(BaseHTTPRequestHandler):
    state = None       # State
    pi = None          # PiRpc
    token = ""
    finish_event = None
    abort_event = None

    def log_message(self, *a):
        pass

    # --- 工具 ---
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Vibe-Token")

    def _auth_ok(self):
        if self.headers.get("X-Vibe-Token") == self.token:
            return True
        # 兼容 ?token= 查询参数
        from urllib.parse import urlparse, parse_qs
        q = parse_qs(urlparse(self.path).query)
        return q.get("token", [None])[0] == self.token

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _ask_respond(self, pend, answer):
        # 应答成功才清除挂起；写入失败（客户端已被 undici headersTimeout 断开等）
        # 保留 pend（含已记录的答案），扩展重连重发 /ask 时直接补发答案，用户回答不丢
        try:
            self._json(200, {"answer": answer})
        except OSError:
            log(f"提问应答发送失败（客户端已断开），保留问题等待重连: {pend['question'][:60]}")
            return
        with self.state.lock:
            if self.state.pending_question and self.state.pending_question["id"] == pend["id"]:
                self.state.pending_question = None

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    # --- 路由 ---
    def do_GET(self):
        if not self._auth_ok():
            return self._json(401, {"error": "unauthorized"})
        from urllib.parse import urlparse, parse_qs
        u = urlparse(self.path)
        if u.path == "/state":
            since = int(parse_qs(u.query).get("since", ["0"])[0] or 0)
            return self._json(200, self.state.snapshot(since))
        if u.path == "/health":
            return self._json(200, {"ok": True})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self._auth_ok():
            return self._json(401, {"error": "unauthorized"})
        from urllib.parse import urlparse
        u = urlparse(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self._json(400, {"error": "invalid json"})

        if u.path == "/prompt":
            if self.state.finished or self.state.aborted:
                return self._json(409, {"error": "会话已结束"})
            if self.pi is None:
                return self._json(503, {"error": "pi 尚未就绪"})
            msg = (body.get("message") or "").strip()
            if not msg:
                return self._json(400, {"error": "message 为空"})
            was_busy = self.state.busy
            if was_busy:
                ok = self.pi.send({"type": "prompt", "message": msg, "streamingBehavior": "steer"})
            else:
                ok = self.pi.send({"type": "prompt", "message": msg})
            if ok:
                self.state.add("user", msg)
                with self.state.lock:
                    self.state.busy = True
                    self.state.waiting_answer = False
                return self._json(200, {"ok": True, "mode": "steer" if was_busy else "prompt"})
            return self._json(502, {"error": "写入 pi 失败，进程可能已退出"})

        if u.path == "/finish":
            self.state.finished = True
            self.finish_event.set()
            return self._json(200, {"ok": True})

        if u.path == "/abort":
            self.state.aborted = True
            self.abort_event.set()
            return self._json(200, {"ok": True})

        # --- ask_user 工具通道 ---
        if u.path == "/ask":
            # pi 扩展调用：登记问题并长挂起，直到用户回答 / 中止 / 完成。
            # 支持断线重挂：扩展 fetch 被断开（undici headersTimeout 默认 300s 会杀长连接）后
            # 会以相同 question 重发 /ask，桥复用原 pend 继续等待；若答案已提交过
            # （上次响应没送达），直接补发，保证用户的回答最终到达 pi。
            if self.state.finished or self.state.aborted:
                return self._json(200, {"aborted": True})
            question = (body.get("question") or "").strip()
            if not question:
                return self._json(400, {"error": "question 为空"})
            with self.state.lock:
                pend = self.state.pending_question
                if pend and pend["question"] != question:
                    return self._json(409, {"error": "已有待回答的问题，请等用户回答后再提问"})
                created = pend is None
                if created:
                    pend = {
                        "id": secrets.token_hex(4),
                        "question": question,
                        "kind": body.get("kind") or "question",
                        "options": [str(o) for o in (body.get("options") or [])][:8],
                        "answer": None,
                        "event": threading.Event(),
                    }
                    self.state.pending_question = pend
                answered = pend["answer"]
            # 注：state.add() 内部会再次取锁，锁不可重入，必须在锁外调用
            if created:
                self.state.add("assistant", f"[提问] {question}")
                log(f"pi 提问（{pend['kind']}），等待用户回答: {question[:80]}")
            else:
                log(f"pi 重挂同一问题（客户端重连）: {question[:60]}")
            if answered is not None:
                return self._ask_respond(pend, answered)
            while not pend["event"].wait(1):
                if self.state.finished or self.state.aborted:
                    break
            with self.state.lock:
                answer = pend["answer"]
            if answer is None:
                with self.state.lock:
                    if self.state.pending_question and self.state.pending_question["id"] == pend["id"]:
                        self.state.pending_question = None
                return self._json(200, {"aborted": True})
            return self._ask_respond(pend, answer)

        if u.path == "/answer":
            # 弹窗提交答案，唤醒挂起的 /ask
            qid = body.get("id") or ""
            answer = str(body.get("answer") or "").strip()
            if not answer:
                return self._json(400, {"error": "answer 为空"})
            with self.state.lock:
                pend = self.state.pending_question
                if not pend or (qid and pend["id"] != qid):
                    return self._json(409, {"error": "当前没有待回答的问题"})
                pend["answer"] = answer
                pend["event"].set()
            self.state.add("user", f"[回答提问] {answer}")
            log(f"用户已回答提问: {answer[:80]}")
            return self._json(200, {"ok": True})

        return self._json(404, {"error": "not found"})


def maybe_auto_finish(state):
    """agent_settled 后调用：auto_finish 开启时判定是否自动结束节点。

    末条助手回复以 ? / ？ 结尾视为 pi 在向用户提问 → 保持 running 等待回答；
    否则自动置成功，流水线继续。
    """
    if not state.auto_finish:
        return
    if state.finished or state.aborted or state.error:
        return
    with state.lock:
        if state.pending_question:
            return  # ask_user 挂起中（理论不会在 settled 时出现，防競态）
        last_text = next(
            (m["text"] for m in reversed(state.messages) if m["role"] == "assistant" and m["text"]),
            "",
        ).strip()
    if last_text and QUESTION_RE.search(last_text):
        with state.lock:
            state.waiting_answer = True
        log("pi 以提问收尾，保持运行，等待弹窗回答（或手动点「完成」）")
        return
    log("pi 回合结束，自动完成节点")
    AUTO_FINISH_EVENT.set()


def handle_event(state, ev):
    """处理 pi rpc 事件流，维护对话 transcript 与忙闲状态。"""
    t = ev.get("type")

    if t == "response":
        cmd = ev.get("command")
        data = ev.get("data") or {}
        if cmd == "get_state" and ev.get("success"):
            with state.lock:
                state.session_id = data.get("sessionId", "")
                state.session_file = data.get("sessionFile", "")
            log(f"pi 会话: {state.session_id}")
        elif cmd == "get_messages" and ev.get("success"):
            rebuild_history(state, data.get("messages") or [])
        elif cmd == "prompt" and not ev.get("success"):
            state.add("system", f"prompt 被拒绝: {ev.get('error') or ev}")
        return

    if t == "turn_start":
        with state.lock:
            state.busy = True
            state.waiting_answer = False
    elif t == "agent_end":
        with state.lock:
            state.busy = False
    elif t == "agent_settled":
        with state.lock:
            state.busy = False
        maybe_auto_finish(state)
    elif t == "turn_end":
        with state.lock:
            state.turns += 1
            state.busy = False
    elif t == "tool_execution_start":
        with state.lock:
            state._pending_tools[ev.get("toolCallId", "")] = {
                "name": ev.get("toolName", "?"),
                "args": trunc(json.dumps(ev.get("args"), ensure_ascii=False), 300),
            }
    elif t == "tool_execution_end":
        with state.lock:
            state.tool_calls += 1
            pending = state._pending_tools.pop(ev.get("toolCallId", ""), {})
        result = ev.get("result")
        preview = trunc(result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, default=str), 500)
        state.add("tool", preview, name=pending.get("name", ev.get("toolName", "?")),
                  args=pending.get("args", ""), is_error=bool(ev.get("isError")))
    elif t == "message_end":
        msg = ev.get("message") or {}
        role = msg.get("role")
        content = msg.get("content")
        if role == "user":
            text = text_of_content(content)
            with state.lock:
                # 去重：入口/桥对用户消息做了乐观追加，pi 的 message_end 会再回显一次
                if state.messages and state.messages[-1]["role"] == "user" and state.messages[-1]["text"] == trunc(text):
                    return
            state.add("user", text)
        elif role == "assistant":
            state.add("assistant", text_of_content(content), tools=tool_calls_of(content))


def rebuild_history(state, messages):
    """续聊重入：从 get_messages 结果重建对话记录。"""
    count = 0
    for msg in messages:
        role = msg.get("role")
        content = msg.get("content")
        if role == "user":
            state.add("user", text_of_content(content))
            count += 1
        elif role == "assistant":
            state.add("assistant", text_of_content(content), tools=tool_calls_of(content))
            count += 1
        elif role == "toolResult":
            preview = trunc(json.dumps(msg.get("content"), ensure_ascii=False, default=str), 500)
            state.add("tool", preview, name=msg.get("toolName", "?"),
                      is_error=bool(msg.get("isError")))
            count += 1
    log(f"已从历史会话重建 {count} 条消息")


def emit_outputs(state, status):
    """打印 flowx-yaml 输出块。"""
    with state.lock:
        msgs = list(state.messages[-OUT_MSGS:])
        last_assistant = next((m["text"] for m in reversed(state.messages)
                               if m["role"] == "assistant" and m["text"]), "")
        turns, tool_calls = state.turns, state.tool_calls
        dropped = state.dropped
    transcript = json.dumps(msgs, ensure_ascii=False)
    while len(transcript) > OUT_CHARS and msgs:
        msgs = msgs[len(msgs) // 2:]
        transcript = json.dumps(msgs, ensure_ascii=False)

    fields = {
        "status": status,
        "summary": trunc(last_assistant, 2000),
        "session_id": state.session_id,
        "session_dir": os.path.dirname(state.session_file) if state.session_file else "",
        "workdir": state.workdir,
        "branch": git_branch(state.workdir),
        "resume_command": resume_command(state.session_file, state.workdir),
        "turns": str(turns),
        "tool_calls": str(tool_calls),
        "transcript": transcript,
        "dropped_messages": str(dropped),
    }
    print("```flowx-yaml")
    for k, v in fields.items():
        print(f"{k}: {json.dumps(str(v), ensure_ascii=False)}")
    print("```")
    sys.stdout.flush()


def main():
    task = param("task")
    workdir = os.path.abspath(os.path.expanduser(param("workdir")))
    model = param("model")
    timeout = int(param("timeout", "172800") or "172800")  # 默认 48 小时
    bridge_port = int(param("bridge_port", "0") or 0)
    auto_finish = param("auto_finish", "true").strip().lower() not in ("0", "false", "no", "off")

    if not task:
        log_error("错误: task 参数为空")
        sys.exit(1)
    if not shutil.which("pi"):
        log_error("错误: 未找到 pi CLI（不在 PATH 中）")
        sys.exit(1)
    os.makedirs(workdir, exist_ok=True)

    vibe_dir = os.path.join(workdir, ".pi-vibe")

    # 会话按 执行实例 × 节点 隔离：同一 workdir 允许被流水线中多个本节点复用
    # （如方案确认/联调验收都在项目根目录），每个节点有独立的会话子目录与
    # execution-id 标记，避免误续聊同 workdir 下其他节点的会话；pi -c 只在
    # 本节点目录内挑最新会话，也不会串到别的节点。无 FLOWX_NODE_ID
    # （旧版运行时 / mock）时回退到共享 sessions 根目录的旧行为。
    node_id = re.sub(r"[^A-Za-z0-9_-]", "_", os.environ.get("FLOWX_NODE_ID", ""))
    if node_id:
        sessions_dir = os.path.join(vibe_dir, "sessions", node_id)
        marker_path = os.path.join(vibe_dir, f"execution-id.{node_id}")
    else:
        sessions_dir = os.path.join(vibe_dir, "sessions")
        marker_path = os.path.join(vibe_dir, "execution-id")
    os.makedirs(sessions_dir, exist_ok=True)

    state = State(workdir, task, model, auto_finish)

    # 同一执行内同一节点的续跑/重入（执行 ID 相同）才 -c 续聊；
    # 全新执行或同 workdir 的其他节点，开新会话（旧会话文件保留，仅不再自动接入）。
    has_sessions = any(f.endswith(".jsonl") for f in os.listdir(sessions_dir))
    exec_id = os.environ.get("FLOWX_WORKFLOW_ID", "")
    prev_exec_id = ""
    try:
        with open(marker_path, encoding="utf-8") as f:
            prev_exec_id = f.read().strip()
    except OSError:
        pass
    if exec_id:
        state.resumed = has_sessions and prev_exec_id == exec_id
        try:
            with open(marker_path, "w", encoding="utf-8") as f:
                f.write(exec_id)
        except OSError as e:
            log(f"警告: 写入 execution-id 标记失败: {e}")
    else:
        # 无执行标识（旧版运行时 / mock），回退旧行为：有会话即续聊
        state.resumed = has_sessions
    log(f"工作区: {workdir} 分支: {state.branch or '(非 git 仓库)'} 续聊: {state.resumed} 自动完成: {auto_finish}")

    # --- 写 ask_user 扩展文件 ---
    ext_path = os.path.join(vibe_dir, "ask-user-extension.ts")
    with open(ext_path, "w", encoding="utf-8") as f:
        f.write(ASK_USER_EXTENSION)

    # --- 启动 HTTP 桥（先于 pi，便于向 pi 注入桥地址） ---
    token = secrets.token_hex(8)
    BridgeHandler.state = state
    BridgeHandler.pi = None
    BridgeHandler.token = token
    BridgeHandler.finish_event = threading.Event()
    BridgeHandler.abort_event = threading.Event()
    # bridge_port=0（默认）由内核直接分配空闲端口——不要用「先探测再绑定」的两步式
    # 选口：并行节点会同时探到同一空闲端口，绑定方必有一边 EADDRINUSE（exec 149 事故）。
    server = ThreadingHTTPServer(("127.0.0.1", bridge_port), BridgeHandler)
    port = server.server_address[1]
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    # 发现行：画布组件从执行日志解析
    bridge_url = f"http://127.0.0.1:{port}"
    print(f"VIBE_BRIDGE url={bridge_url} token={token}", flush=True)
    log(f"交互桥已就绪: {bridge_url}")

    # --- 启动 pi rpc（注入 ask_user 扩展与桥地址） ---
    pi = PiRpc(
        workdir, sessions_dir, model, state.resumed,
        lambda ev: handle_event(state, ev),
        extra_args=["-e", ext_path],
        extra_env={"VIBE_BRIDGE_URL": bridge_url, "VIBE_BRIDGE_TOKEN": token},
    )
    BridgeHandler.pi = pi

    def on_signal(signum, frame):
        pi.terminate()
        sys.exit(1)
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    # --- 初始化会话 ---
    time.sleep(1)  # 等 pi rpc 启动
    pi.send({"type": "get_state"})
    if state.resumed:
        pi.send({"type": "get_messages"})
        log("续聊模式：task 不重复发送，请在画布弹窗中继续对话")
    else:
        state.add("user", task)
        with state.lock:
            state.busy = True
        pi.send({"type": "prompt", "message": task})

    # --- 主等待循环 ---
    start = time.time()
    status = None
    while True:
        if BridgeHandler.finish_event.is_set() or AUTO_FINISH_EVENT.is_set():
            status = "success"
            break
        if BridgeHandler.abort_event.is_set():
            status = "aborted"
            break
        rc = pi.poll()
        if rc is not None:
            state.error = f"pi 进程退出 (exit={rc})"
            status = "error"
            break
        if timeout > 0 and time.time() - start > timeout:
            state.error = f"超时 ({timeout}s)"
            status = "timeout"
            break
        time.sleep(0.5)

    # --- 收尾 ---
    if status == "success":
        pi.send({"type": "abort"})  # 停掉进行中的流
        time.sleep(1)
    pi.terminate()
    if state.error:
        log_error(f"结束: {status} ({state.error})")
    else:
        log(f"结束: {status}，会话可用 {resume_command(state.session_file, state.workdir)} 恢复")
    emit_outputs(state, status)
    server.shutdown()
    sys.exit(0 if status == "success" else 1)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log_error(f"节点异常: {e}")
        log(traceback.format_exc())
        sys.exit(1)
