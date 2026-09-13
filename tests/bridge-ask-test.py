"""桥 /ask 断线重挂与答案补发测试（不依赖 pi 进程）。"""
import http.client
import importlib.util
import json
import socket
import threading
import time

spec = importlib.util.spec_from_file_location(
    "vibe_main",
    "/data/data/com.termux/files/home/workspace/github.com/LerkoX/flowx-vibe-coding/nodes/pi-vibe-coding/main.py",
)
m = spec.loader.load_module()

state = m.State("/tmp", "task", "", True)
m.BridgeHandler.state = state
m.BridgeHandler.pi = None
m.BridgeHandler.token = "tok"
m.BridgeHandler.finish_event = threading.Event()
m.BridgeHandler.abort_event = threading.Event()
server = m.ThreadingHTTPServer(("127.0.0.1", 0), m.BridgeHandler)
server.daemon_threads = True
port = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()

PASS = True
def check(cond, msg):
    global PASS
    print(("ok: " if cond else "FAIL: ") + msg)
    if not cond:
        PASS = False

def req(method, path, payload=None, timeout=10):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    body = json.dumps(payload) if payload is not None else None
    c.request(method, path, body=body, headers={"X-Vibe-Token": "tok", "Content-Type": "application/json"})
    r = c.getresponse()
    data = json.loads(r.read() or b"{}")
    c.close()
    return r.status, data

def post_ask_async(question, holder):
    def run():
        try:
            holder["result"] = req("POST", "/ask", {"question": question, "kind": "confirm"})
        except Exception as e:
            holder["error"] = e
    t = threading.Thread(target=run, daemon=True)
    t.start()
    return t

def wait_pending():
    for _ in range(50):
        _, s = req("GET", "/state?since=0")
        if s.get("pending_question"):
            return s["pending_question"]
        time.sleep(0.1)
    return None

# --- 1. 正常流程 ---
h = {}
post_ask_async("采用方案A吗？", h)
pq = wait_pending()
check(pq and pq["question"] == "采用方案A吗？", "问题登记并出现在 /state")
st, _ = req("POST", "/answer", {"id": pq["id"], "answer": "确认"})
check(st == 200, "/answer 接受回答")
for _ in range(50):
    if "result" in h:
        break
    time.sleep(0.1)
check(h.get("result") == (200, {"answer": "确认"}), f"/ask 长挂起返回答案: {h.get('result')}")
_, s = req("GET", "/state?since=0")
check(s.get("pending_question") is None, "应答后挂起清除")

# --- 2. 409：挂起中不同问题被拒 ---
h1, h2 = {}, {}
post_ask_async("问题一？", h1)
pq1 = wait_pending()
st, d = req("POST", "/ask", {"question": "另一个问题？"})
check(st == 409, f"不同问题 409: {st} {d}")
req("POST", "/answer", {"id": pq1["id"], "answer": "答一"})
time.sleep(0.5)

# --- 3. 断线重挂：客户端提前断开（模拟 undici headersTimeout），答案补发 ---
# 裸 socket 发 /ask 请求后直接断开，不等响应
raw = socket.create_connection(("127.0.0.1", port))
body = json.dumps({"question": "断线问题？", "kind": "question"})
raw.sendall(
    f"POST /ask HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Vibe-Token: tok\r\n"
    f"Content-Type: application/json\r\nContent-Length: {len(body.encode())}\r\n\r\n".encode() + body.encode()
)
pq2 = wait_pending()
check(pq2 and pq2["question"] == "断线问题？", "裸连接问题登记")
raw.close()  # 客户端断开，服务器尚未应答
time.sleep(0.3)
# 用户照常回答（此刻 /ask 处理线程醒来写响应 → BrokenPipe，pend 必须保留）
st, _ = req("POST", "/answer", {"id": pq2["id"], "answer": "选B"})
check(st == 200, "断线后 /answer 仍接受回答")
time.sleep(0.8)  # 给 /ask 线程写入失败的时间
_, s = req("GET", "/state?since=0")
check(s.get("pending_question") is not None, "响应未送达时 pend 保留（含答案）")
# 扩展重连：相同 question 重发 /ask → 立即补发答案
st, d = req("POST", "/ask", {"question": "断线问题？", "kind": "question"})
check(st == 200 and d.get("answer") == "选B", f"重连补发答案: {st} {d}")
_, s = req("GET", "/state?since=0")
check(s.get("pending_question") is None, "补发成功后挂起清除")

server.shutdown()
print("ALL PASS" if PASS else "SOME FAILED")
raise SystemExit(0 if PASS else 1)
