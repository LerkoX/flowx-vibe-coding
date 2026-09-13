#!/usr/bin/env python3
"""pi-vibe-coding mock：不起 pi 与桥，返回一段假对话供画布 UI 预览。"""
import json
import os
import shlex
import time


def param(name, default=""):
    for key in ("VIBE_" + name.upper(), "FLOWX_PARAM_" + name.upper(), name.upper()):
        v = os.environ.get(key)
        if v:
            return v
    return default


workdir = os.path.abspath(os.path.expanduser(param("workdir", "~/vibe-workspace")))
task = param("task", "帮我重构登录模块")
now = int(time.time() * 1000)

transcript = [
    {"i": 0, "role": "user", "text": task, "ts": now - 60_000},
    {"i": 1, "role": "assistant", "text": "好的，我先看一下登录模块的现有结构。",
     "tools": [{"name": "bash", "args": '{"command":"ls src/auth"}'}], "ts": now - 55_000},
    {"i": 2, "role": "tool", "name": "bash", "text": "index.ts\nlogin.ts\nsession.ts", "ts": now - 54_000},
    {"i": 3, "role": "assistant",
     "text": "已完成重构：\n- login.ts 拆分为 authenticate / authorize 两层\n- session.ts 增加过期刷新\n- 所有测试通过", "ts": now - 5_000},
]

fields = {
    "status": "success",
    "summary": transcript[-1]["text"],
    "session_id": "mock-01a08d53-3e7e-7ce3-b78a-590bcc18e240",
    "session_dir": os.path.join(workdir, ".pi-vibe", "sessions"),
    "workdir": workdir,
    "branch": "main",
    "resume_command": f"cd {shlex.quote(workdir)} && pi --session-dir {shlex.quote(os.path.join(workdir, '.pi-vibe', 'sessions'))} -c",
    "turns": "2",
    "tool_calls": "1",
    "transcript": json.dumps(transcript, ensure_ascii=False),
    "dropped_messages": "0",
}

print("[pi-vibe-coding][mock] 模拟运行完成（未启动 pi）")
print("```flowx-yaml")
for k, v in fields.items():
    print(f"{k}: {json.dumps(str(v), ensure_ascii=False)}")
print("```")
