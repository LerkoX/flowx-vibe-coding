# flowx-vibe-coding

FlowX Studio 的 vibe coding 节点包：在流水线中驱动本机 [pi](https://github.com/earendil-works/pi-mono) CLI 执行编码任务，画布上提供状态灯与可交互的聊天弹窗（人在环）。

## 节点列表

| 节点 | 说明 |
| --- | --- |
| `pi-vibe-coding` | 交互式 vibe coding 节点（仅 local 执行器），见 `nodes/pi-vibe-coding/` |

## 工作方式

```
节点 running（黄灯）
  ├─ 入口脚本 spawn `pi --mode rpc --session-dir <workdir>/.pi-vibe/sessions`
  ├─ 同时在 127.0.0.1 起 HTTP 桥，并把 `VIBE_BRIDGE url=... token=...` 打到节点日志
  ├─ 画布组件从执行日志解析桥地址 → 轮询对话、发送用户输入
  └─ 用户在弹窗中点：
       ✅ 完成任务 → 节点 success（绿灯），流水线继续下游
       ⛔ 中止     → 节点 failed（红灯）
pi 崩溃 / 超时      → 节点 failed（红灯）
```

- **重入续聊**：pi 会话持久化在 `<workdir>/.pi-vibe/sessions`。重新运行流水线（或节点重跑）时，只要 `workdir` 不变，自动以 `pi -c` 恢复同一会话，历史对话经 `get_messages` 重建，任务描述不会重复发送。注意：`execution continue` 会跳过已终结（含 failed）的节点，不能用于重跑中止后的节点。
- **终端接管**：卡片/弹窗展示 pi 会话 ID，并提供一键复制恢复命令（`pi --session-dir '<dir>' -c`），可在终端接着同一会话查看/操作。

## 导入与使用

```bash
flowx-studio server start   # 如未运行
flowx-studio node import --type folder --path flowx-vibe-coding/nodes/pi-vibe-coding
flowx-studio node mock --id <N>   # Mock 预览（假对话数据，不起 pi）
```

workflow YAML 中引用：

```yaml
Nodes:
  Vibe:
    name: Vibe Coding
    config:
      nodeRef: pi-vibe-coding@1.0.0
      params:
        task: "{{ Param.task }}"
        workdir: "{{ Param.workdir }}"
```

## 参数

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `task` | 是 | — | 任务描述，仅首次运行作为首个 prompt 发送 |
| `workdir` | 是 | — | pi 工作目录；会话存于 `<workdir>/.pi-vibe/`，重入续聊的依据 |
| `model` | 否 | 系统默认 | 透传 `pi --model` |
| `timeout` | 否 | `0` | 节点整体超时秒数，`0` 不限 |
| `bridge_port` | 否 | `0` | 交互桥端口，`0` 自动（17800 起扫描） |

## 限制

- **仅 local 执行器**（依赖宿主机 pi CLI 与工作区文件系统）。
- 交互桥绑定 `127.0.0.1`；画布组件会把桥地址主机名替换为当前 Studio 页面主机名，因此局域网用 `http://<主机>:8080` 访问 Studio 时交互也可用；跨机访问（桥与浏览器不同机）时聊天输入不可用，只能只读回放。
- 节点 running 期间会一直占用流水线等待用户点「完成」，这是预期的人在环语义。
- pi 以用户本机默认配置运行（含已安装的扩展、技能、MCP），模型可用 `model` 参数覆盖。
- 桥 token 会出现在节点执行日志中（Studio 内可见执行日志的用户即可交互），仅面向可信本地环境。
- 依赖 flowx local 执行器 PTY 模式的退出码透传修复（`script -q -e -c`，见 `flowx/executor/local/local.go`）；旧版本 server 下「中止」无法让节点变红灯。
