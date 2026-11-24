// Клиент OBS WebSocket (протокол obs-websocket 5, встроен в OBS 28+).
// Отдаёт статус стрима: LIVE/REC-таймкоды, битрейт, потери кадров,
// «пробки» сети (congestion), FPS, CPU. События: 'status', 'log'.
const { EventEmitter } = require('events');
const crypto = require('crypto');
const WebSocket = require('ws');

class ObsClient extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.cfg = { host: '127.0.0.1', port: 4455, password: '' };
    this.pollTimer = null;
    this.supervisor = null;
    this.reqId = 0;
    this.pending = {};
    this.stream = null;
    this.stats = null;
    this.connected = false;
    this.lastBytes = null;
    this.lastT = null;
    this.lastMbps = null;
    this.stopped = true;
  }

  log(m) { this.emit('log', m); }

  start(cfgGetter) {
    this.getCfg = cfgGetter || null;
    this.stopped = false;
    // надзиратель: раз в 5 сек проверяет сокет и пересоздаёт при любых проблемах —
    // не может застрять, в отличие от цепочки error->close->reconnect
    if (!this.supervisor) this.supervisor = setInterval(() => this.ensure(), 5000);
    this.ensure();
  }

  stop() {
    this.stopped = true;
    if (this.supervisor) { clearInterval(this.supervisor); this.supervisor = null; }
    this.killSocket();
  }

  // при смене настроек — пересоздаём сокет только если они реально менялись
  reconfigure(cfgGetter) {
    if (cfgGetter) this.getCfg = cfgGetter;
    const next = this.getCfg ? this.getCfg() : this.cfg;
    const changed = String(next.host) !== String(this.cfg.host) ||
      Number(next.port) !== Number(this.cfg.port) ||
      (next.password || '') !== (this.cfg.password || '');
    if (changed && !this.stopped) {
      this.log('настройки изменились — переподключение');
      this.killSocket();
      this.ensure();
    }
  }

  killSocket() {
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.terminate(); } catch {}
      this.ws = null;
    }
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.connected) { this.connected = false; this.emitStatus(); }
  }

  ensure() {
    if (this.stopped) return;
    // перечитываем конфиг при каждом тике — подхватываем изменения OBS
    if (this.getCfg) { try { const c = this.getCfg(); if (c) this.cfg = c; } catch {} }

    if (this.ws) {
      const st = this.ws.readyState; // 0 connecting, 1 open, 2 closing, 3 closed
      if (st === 1 && this.connected) return; // живо
      const stuck = Date.now() - (this.openedAt || 0) > 5000;
      if ((st === 0 || st === 1) && !stuck) return; // ещё подключается — дать шанс
      try { this.ws.removeAllListeners(); this.ws.terminate(); } catch {}
      this.ws = null;
      this.connected = false;
    }

    this.openedAt = Date.now();
    const url = `ws://${this.cfg.host}:${this.cfg.port}`;
    let ws;
    try { ws = new WebSocket(url); } catch { return; } // следующий тик повторит
    this.ws = ws;
    ws.on('message', (data) => {
      try { this.handle(JSON.parse(data.toString())); } catch (e) { this.log('кривое сообщение: ' + e.message); }
    });
    ws.on('error', (e) => this.log('нет связи: ' + (e.message || e.code)));
    ws.on('close', (code, reason) => {
      this.log('сокет закрыт (' + code + (reason && reason.length ? ' ' + reason.toString() : '') + ')');
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
      const was = this.connected;
      this.connected = false;
      if (was) this.emitStatus();
    });
  }

  send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }

  request(requestType) {
    const id = 'r' + (++this.reqId);
    this.pending[id] = requestType;
    this.send({ op: 6, d: { requestType, requestId: id } });
  }

  handle(msg) {
    if (msg.op === 0) { // Hello — сервер сообщает поддерживаемую rpcVersion
      this.rpcVersion = Number(msg.d.rpcVersion) || 5;
      let auth;
      const a = msg.d.authentication;
      if (a) {
        if (!this.cfg.password) this.log('OBS требует пароль — укажи его в настройках виджета');
        const secret = crypto.createHash('sha256').update((this.cfg.password || '') + a.salt).digest('base64');
        auth = crypto.createHash('sha256').update(secret + a.challenge).digest('base64');
      }
      this.send({ op: 1, d: { rpcVersion: this.rpcVersion, ...(auth ? { authentication: auth } : {}) } });
    } else if (msg.op === 2) { // Identified
      this.log('подключено к OBS (rpc v' + this.rpcVersion + ')');
      this.connected = true;
      this.pollTimer = setInterval(() => {
        this.request('GetStreamStatus');
        this.request('GetStats');
      }, 1000);
      this.emitStatus();
    } else if (msg.op === 5) { // Event
      if (msg.d.eventType === 'StreamStateChanged') this.stream = msg.d.eventData;
      this.emitStatus();
    } else if (msg.op === 7) { // RequestResponse
      const t = this.pending[msg.d.requestId];
      delete this.pending[msg.d.requestId];
      if (!t) return;
      const data = msg.d.responseData || {};
      if (t === 'GetStreamStatus') this.stream = data;
      else if (t === 'GetStats') this.stats = data;
      else return;
      this.emitStatus();
    }
  }

  getStatus() {
    const s = this.stream || {};
    const streaming = !!s.outputActive;
    const now = Date.now();

    // битрейт из дельты байт, сглаженный
    let mbps = 0;
    if (streaming && Number.isFinite(s.outputBytes)) {
      if (this.lastBytes != null && this.lastT != null && now > this.lastT && s.outputBytes >= this.lastBytes) {
        const bps = (s.outputBytes - this.lastBytes) * 8 / ((now - this.lastT) / 1000);
        mbps = this.lastMbps == null ? bps / 1e6 : this.lastMbps * 0.6 + (bps / 1e6) * 0.4;
      } else if (this.lastMbps != null) {
        mbps = this.lastMbps;
      }
    }
    this.lastBytes = streaming ? s.outputBytes : null;
    this.lastT = now;
    this.lastMbps = streaming ? mbps : null;

    const total = Number.isFinite(s.outputTotalFrames) ? s.outputTotalFrames : 0;
    const skipped = Number.isFinite(s.outputSkippedFrames) ? s.outputSkippedFrames : 0;
    const droppedPct = total > 0 ? (skipped / total) * 100 : 0;

    const congestion = Number.isFinite(s.outputCongestion) ? s.outputCongestion : 0;
    let quality = 'отлично';
    if (congestion > 0.1) quality = 'плохо';
    else if (congestion > 0.05) quality = 'нестабильно';
    else if (congestion > 0.02) quality = 'хорошо';

    const g = this.stats || {};
    const rTotal = Number.isFinite(g.renderTotalFrames) ? g.renderTotalFrames : 0;
    const rSkip = Number.isFinite(g.renderSkippedFrames) ? g.renderSkippedFrames : 0;

    return {
      connected: !!this.connected,
      streaming,
      recording: !!s.recordActive,
      stream: streaming ? {
        timecode: s.outputTimecode || '',
        bitrateMbps: +mbps.toFixed(2),
        droppedPct: +droppedPct.toFixed(2),
        congestion: +congestion.toFixed(3),
        quality,
        reconnecting: !!s.outputReconnecting
      } : null,
      record: s.recordActive ? { timecode: s.recordTimecode || '' } : null,
      stats: {
        fps: Number.isFinite(g.activeFps) ? +g.activeFps.toFixed(0) : null,
        cpu: Number.isFinite(g.cpuUsage) ? +g.cpuUsage.toFixed(0) : null,
        renderDroppedPct: rTotal > 0 ? +((rSkip / rTotal) * 100).toFixed(2) : 0
      }
    };
  }

  emitStatus() { this.emit('status', this.getStatus()); }
}

module.exports = new ObsClient();
