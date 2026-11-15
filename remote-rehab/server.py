#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ReMotion-K × 庆云大学 分屏中继服务器（纯标准库，无第三方依赖）

用法:  python3 server.py [端口]      （默认 8000，绑定 0.0.0.0）

入口:
  http://localhost:8000/split.html                  分屏（浏览器内切换"中继"）
  http://localhost:8000/index.html?edge=1&relay=1   企业现场边缘端（单页）
  http://localhost:8000/center-twin.html?relay=1    庆云大学控制中心（单页）

中继 API（结构化数据，无视频）:
  POST /r/in?from=X    body: 单个信封或信封数组（JSON, ≤1MB）
                       → 写入 500 条环形缓存，并推送给 from!=X 的 SSE 订阅者
  GET  /r/out?from=X   SSE 事件流; 带 Last-Event-ID 断线重放; 15s 心跳
"""
import json
import os
import socket
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
MAX_BODY = 1 << 20          # 1 MB
RING_MAX = 500              # 环形缓存条数
HB_SEC = 15                 # SSE 心跳间隔

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".md": "text/plain; charset=utf-8",
    ".onnx": "application/octet-stream",
    ".task": "application/octet-stream",
    ".wasm": "application/wasm",
    ".png": "image/png",
    ".ico": "image/x-icon",
}

# ---- 事件中继状态 ----
ring = deque(maxlen=RING_MAX)       # (server_seq, envelope)
subs = {}                            # from -> [queue, condition]
seq_counter = 0
lock = threading.Lock()


def publish(envelope):
    global seq_counter
    with lock:
        seq_counter += 1
        item = (seq_counter, envelope)
        ring.append(item)
        for name, q in list(subs.items()):
            if name != envelope.get("from"):
                q.append(item)   # append 内部已持锁并 notify_all


class SubQueue(object):
    """有上限的订阅队列（慢消费者丢最旧包，避免内存膨胀）"""

    def __init__(self, limit=1000):
        self.dq = deque(maxlen=limit)
        self.condition = threading.Condition()

    def append(self, item):
        with self.condition:
            self.dq.append(item)
            self.condition.notify_all()

    def drain(self):
        with self.condition:
            out = list(self.dq)
            self.dq.clear()
            return out


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"   # SSE 必需（保持连接）
    server_version = "ReMotionK-Relay/1.0"

    # ---- 静态文件 ----
    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/r/out":
            return self.sse(u)
        return self.static(u.path)

    def static(self, path):
        if path == "/":
            path = "/index.html"
        rel = os.path.normpath(path.lstrip("/"))
        full = os.path.normpath(os.path.join(ROOT, rel))
        try:   # 防穿越：解析后必须仍在站点根目录内
            if os.path.commonpath([full, os.path.normpath(ROOT)]) != os.path.normpath(ROOT):
                return self.plain(404, "Not Found\n")
        except ValueError:
            return self.plain(404, "Not Found\n")
        if not os.path.isfile(full):
            return self.plain(404, "Not Found\n")
        ext = os.path.splitext(full)[1].lower()
        data = open(full, "rb").read()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    # ---- SSE 订阅 ----
    def sse(self, u):
        qs = parse_qs(u.query)
        name = (qs.get("from") or ["?"])[0]
        last = self.headers.get("Last-Event-ID", "0")
        try:
            last = int(last)
        except ValueError:
            last = 0
        q = SubQueue()
        with lock:
            subs[name] = q
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            # 断线续传：重放 Last-Event-ID 之后的缓存
            for seq, env in list(ring):
                if seq > last and env.get("from") != name:
                    self.write_sse(seq, env)
            last_write = time.time()
            while True:
                batch = q.drain()
                if batch:
                    for seq, env in batch:
                        if env.get("from") != name:
                            self.write_sse(seq, env)
                    last_write = time.time()
                elif time.time() - last_write >= HB_SEC:
                    self.wfile.write(b":hb\n\n")
                    self.wfile.flush()
                    last_write = time.time()
                with q.condition:
                    q.condition.wait(timeout=1.0)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with lock:
                subs.pop(name, None)

    def write_sse(self, seq, env):
        body = json.dumps(env, ensure_ascii=False).encode("utf-8")
        self.wfile.write(b"id: %d\ndata: %s\n\n" % (seq, body))
        self.wfile.flush()

    # ---- 入站 ----
    def do_POST(self):
        u = urlparse(self.path)
        if u.path != "/r/in":
            return self.plain(404, "Not Found\n")
        qs = parse_qs(u.query)
        name = (qs.get("from") or ["?"])[0]
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > MAX_BODY:
                return self.plain(413, "Payload Too Large\n")
            raw = self.rfile.read(n)
            data = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return self.plain(400, "Bad JSON\n")
        items = data if isinstance(data, list) else [data]
        for env in items:
            if isinstance(env, dict) and env.get("app") == "shinek-twin":
                env.setdefault("from", name)
                publish(env)
        self.plain(200, "OK\n")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Last-Event-ID")
        self.end_headers()

    def plain(self, code, text):
        body = text.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):   # 精简日志
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def main():
    port = 8000
    import sys
    if len(sys.argv) > 1:
        port = int(sys.argv[1])
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    ip = lan_ip()
    print("=" * 58)
    print("ReMotion-K × 庆云大学 分屏中继服务器 (纯标准库)")
    print("=" * 58)
    print("本机入口:")
    print("  分屏:      http://localhost:%d/split.html" % port)
    print("  企业边缘:  http://localhost:%d/index.html?edge=1&relay=1" % port)
    print("  控制中心:  http://localhost:%d/center-twin.html?relay=1" % port)
    print("局域网(另一台电脑):  http://%s:%d/ ..." % (ip, port))
    print("中继: POST /r/in?from=X (JSON)  |  GET /r/out?from=X (SSE)")
    print("Ctrl+C 停止")
    print("=" * 58)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
