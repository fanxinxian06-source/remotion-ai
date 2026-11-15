/* twin-link.js · ReMotion-K × 庆云大学 结构化数据链路（经典脚本，file:// 可用）
 * 信封: {app:'shinek-twin', from, seq, ts, type, role:'edge'|'center', bytes, data}
 * 类型 → 车道: hello(紫) twin(蓝) vitals(绿) incident(红) center-hello/receipt/command(橙)
 * 传输: BroadcastChannel('shinek-twin') + 向 window.parent postMessage（file:// 主通路）
 *       + 可选 HTTP 中继（?relay=1: 150ms 缓冲 POST /r/in，EventSource /r/out 接收）
 * 防环: 本模块只派发、绝不转发收到的包；from 相同的包直接丢弃；from:seq 去重。
 * 心跳由页面自己维护：edge 每 8s 发 hello，center 每 5s 发 center-hello。 */
(function () {
  'use strict';
  var APP = 'shinek-twin', CHANNEL = 'shinek-twin';
  var SELF = null, seq = 0, seen = new Map(), handlers = [], bc = null, es = null,
      outBuf = [], flushT = null;

  function rid() { return Math.random().toString(36).slice(2, 8); }
  function ubytes(s) { try { return unescape(encodeURIComponent(s)).length; } catch (e) { return s.length; } }

  function deliver(type, data) {
    if (!SELF) return null;
    var m = { app: APP, from: SELF.from, seq: ++seq, ts: Date.now(), type: type, role: SELF.role, bytes: 0, data: data || {} };
    try { m.bytes = ubytes(JSON.stringify(m.data)); } catch (e) {}
    if (bc) { try { bc.postMessage(m); } catch (e) {} }
    if (window.parent && window.parent !== window) { try { window.parent.postMessage(m, '*'); } catch (e) {} }
    if (SELF.relay) { outBuf.push(m); if (outBuf.length > 300) outBuf.shift(); schedule(); }
    return m;
  }

  function schedule() { if (!flushT) flushT = setTimeout(flush, 150); }

  function flush() {
    flushT = null;
    if (!SELF || !SELF.relay || !outBuf.length) return;
    var batch = outBuf; outBuf = [];
    var body; try { body = JSON.stringify(batch); } catch (e) { return; }
    fetch('/r/in?from=' + encodeURIComponent(SELF.from), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true
    }).catch(function () { /* 遥测允许丢失；hello 心跳会重建对端状态 */ });
  }

  function ingest(m) {
    if (!SELF || !m || m.app !== APP || !m.type || m.from === SELF.from) return;
    var k = m.from + ':' + m.seq;
    if (seen.has(k)) return;
    seen.set(k, 1);
    if (seen.size > 5000) seen.delete(seen.keys().next().value);
    for (var i = 0; i < handlers.length; i++) { try { handlers[i](m); } catch (e) {} }
  }

  function connectES() {
    if (typeof EventSource === 'undefined' || !/^https?:$/.test(location.protocol)) return;
    try { es = new EventSource('/r/out?from=' + encodeURIComponent(SELF.from)); } catch (e) { return; }
    es.onmessage = function (e) { try { ingest(JSON.parse(e.data)); } catch (err) {} };
    es.onerror = function () {
      if (es && es.readyState === EventSource.CLOSED) { /* ES 自动重连；仅死态重建 */
        try { es.close(); } catch (e) {}
        es = null; connectES();
      }
    };
  }

  window.SHKTwinLink = {
    APP: APP, CHANNEL: CHANNEL,
    init: function (o) {
      SELF = { role: (o && o.role === 'center') ? 'center' : 'edge', relay: !!(o && o.relay) };
      SELF.from = (SELF.role === 'center' ? 'kwu-' : 're-') + rid();
      try { bc = new BroadcastChannel(CHANNEL); bc.onmessage = function (e) { ingest(e.data); }; }
      catch (e) { bc = null; }
      window.addEventListener('message', function (e) { if (e.source === window) return; ingest(e.data); });
      if (SELF.relay) connectES();
      return SELF;
    },
    send: deliver,
    on: function (h) { handlers.push(h); },
    info: function () { return SELF; }
  };
})();
