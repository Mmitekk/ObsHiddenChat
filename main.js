const { app, BrowserWindow, WebContentsView, Tray, Menu, nativeImage, globalShortcut, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const tls = require('tls');
const net = require('net');
const dns = require('dns');
const obs = require('./obs');

// Звук уведомлений без первого клика пользователя
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ВАЖНО: не отключать GPU-ускорение — прозрачные окна (transparent: true)
// при софтверном композитинге не рисуются вовсе (известная беда Electron)

// Тестовый режим: окно ВИДНО в захвате (для проверки скриншотами)
const CAPTURE_TEST = process.env.CHAT_CAPTURE_TEST === '1';

let win = null;
let tray = null;
let chatView = null;
let settingsWin = null;
let barH = 0;
let currentUrl = '';
let savedZoom = 1;
let loginMode = false;

const state = {
  topmost: true,
  hiddenFromCapture: !CAPTURE_TEST,
  opacity: 1,
  clickThrough: false
};

// Настройки звука, отслеживания зрителей и OBS
const cfg = {
  sound: true,
  volume: 0.7,
  sounds: { common: 'ping', sub: 'inherit', follower: 'inherit', nonfollower: 'inherit' },
  userAlerts: [], // массив { id, username, sound, customSoundPath, enabled }
  notifyAllArrivals: false,
  allArrivalsSound: 'ping',
  arrivalCooldown: 60, // секунд между повторными оповещениями одного человека
  obsHost: '127.0.0.1',
  obsPort: 4455,
  obsPassword: '',
  obsPanelOpacity: 0.9
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}

function mergeCfg(patch) {
  if ('sound' in patch) cfg.sound = !!patch.sound;
  if (Number.isFinite(patch.volume)) cfg.volume = Math.max(0, Math.min(1, patch.volume));
  if (Number.isFinite(patch.zoom)) savedZoom = Math.min(2, Math.max(0.5, patch.zoom));
  if (patch.sounds && typeof patch.sounds === 'object') Object.assign(cfg.sounds, patch.sounds);
  if (Array.isArray(patch.userAlerts)) cfg.userAlerts = patch.userAlerts;
  if ('notifyAllArrivals' in patch) cfg.notifyAllArrivals = !!patch.notifyAllArrivals;
  if ('allArrivalsSound' in patch) cfg.allArrivalsSound = String(patch.allArrivalsSound || 'ping');
  if (Number.isFinite(patch.arrivalCooldown)) cfg.arrivalCooldown = Math.max(5, Math.min(600, patch.arrivalCooldown));
  if ('obsHost' in patch) cfg.obsHost = String(patch.obsHost || '').trim() || '127.0.0.1';
  if ('obsPort' in patch) { const p = Number(patch.obsPort); if (Number.isFinite(p) && p > 0 && p < 65536) cfg.obsPort = Math.round(p); }
  if ('obsPassword' in patch) cfg.obsPassword = String(patch.obsPassword || '');
  if (Number.isFinite(patch.obsPanelOpacity)) cfg.obsPanelOpacity = Math.max(0.2, Math.min(1, patch.obsPanelOpacity));
}

function broadcastCfg() {
  const snapshot = {
    sound: cfg.sound, volume: cfg.volume, zoom: savedZoom, sounds: { ...cfg.sounds },
    userAlerts: [ ...cfg.userAlerts ], notifyAllArrivals: cfg.notifyAllArrivals,
    allArrivalsSound: cfg.allArrivalsSound, arrivalCooldown: cfg.arrivalCooldown,
    obsHost: cfg.obsHost, obsPort: cfg.obsPort, obsPassword: cfg.obsPassword, obsPanelOpacity: cfg.obsPanelOpacity
  };
  if (win && !win.webContents.isDestroyed()) win.webContents.send('cfg', snapshot);
  if (settingsWin && !settingsWin.webContents.isDestroyed()) settingsWin.webContents.send('cfg', snapshot);
  if (obsPanelWin && !obsPanelWin.isDestroyed()) obsPanelWin.setOpacity(cfg.obsPanelOpacity);
  obs.reconfigure(obsAutoCfg);
}

function saveSettings(patch) {
  try {
    const all = { ...loadSettings(), ...patch };
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(all, null, 2));
  } catch {}
  mergeCfg(patch);
  broadcastCfg();
}

function saveBounds() {
  if (!win || win.isDestroyed()) return;
  saveSettings(win.getBounds());
}

function applyState() {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(!!state.topmost, 'screen-saver');
  win.setContentProtection(!!state.hiddenFromCapture);
  win.setOpacity(state.opacity);
  win.setIgnoreMouseEvents(!!state.clickThrough, { forward: true });
  if (win.webContents && !win.webContents.isDestroyed()) {
    win.webContents.send('state', { ...state });
  }
  if (settingsWin && !settingsWin.webContents.isDestroyed()) {
    settingsWin.webContents.send('state', { ...state });
  }
}

function showWindow() {
  if (!win) return;
  win.show();
  win.focus();
}

// --- звуки уведомлений чата ---
let lastNotify = 0;
function notifySound(type) {
  if (!cfg.sound) return;
  let s = cfg.sounds[type] || 'inherit';
  if (s === 'inherit') s = cfg.sounds.common;
  if (!s || s === 'none') return;
  const now = Date.now();
  if (now - lastNotify < 1200) return; // троттлинг при быстром чате
  lastNotify = now;
  if (win && !win.webContents.isDestroyed()) {
    win.webContents.send('chat:notify', { sound: s, volume: cfg.volume, type });
  }
}

// --- Онлайн-зрители (все подключенные к чату/стриму: чаттеры, зрители, модераторы) ---
const onlineViewers = new Map(); // username -> { username, displayName, joinedAt }
let initialNamesLoaded = false;
const lastArrivalAlerts = new Map(); // username -> timestamp
let namesSyncTimer = null;
let viewersDebounce = null;

function broadcastViewers() {
  if (viewersDebounce) clearTimeout(viewersDebounce);
  viewersDebounce = setTimeout(() => {
    const list = Array.from(onlineViewers.values()).sort((a, b) => a.username.localeCompare(b.username));
    const payload = {
      count: onlineViewers.size,
      viewers: list
    };
    if (win && !win.webContents.isDestroyed()) win.webContents.send('viewers:update', payload);
    if (settingsWin && !settingsWin.webContents.isDestroyed()) settingsWin.webContents.send('viewers:update', payload);
  }, 150);
}

function checkUserArrivalAlert(rawUsername, displayName) {
  if (!rawUsername) return;
  const username = rawUsername.toLowerCase().trim();
  if (username.startsWith('justinfan')) return;

  const now = Date.now();
  const cooldownMs = (cfg.arrivalCooldown || 60) * 1000;
  const lastAlert = lastArrivalAlerts.get(username) || 0;
  if (now - lastAlert < cooldownMs) return;

  const alerts = Array.isArray(cfg.userAlerts) ? cfg.userAlerts : [];
  const found = alerts.find(a => (a.username || '').toLowerCase().trim() === username && a.enabled !== false);

  if (found) {
    lastArrivalAlerts.set(username, now);
    triggerArrival(username, displayName || rawUsername, found.sound || 'custom', found.customSoundPath);
    return;
  }

  if (cfg.notifyAllArrivals) {
    lastArrivalAlerts.set(username, now);
    triggerArrival(username, displayName || rawUsername, cfg.allArrivalsSound || 'ping', null);
  }
}

function triggerArrival(username, displayName, sound, customSoundPath) {
  if (!cfg.sound) return;
  const payload = {
    username,
    displayName: displayName || username,
    sound: sound || 'ping',
    customSoundPath: customSoundPath || null,
    volume: cfg.volume
  };
  if (win && !win.webContents.isDestroyed()) {
    win.webContents.send('chat:arrival', payload);
  }
  if (settingsWin && !settingsWin.webContents.isDestroyed()) {
    settingsWin.webContents.send('chat:arrival', payload);
  }
}

// --- IRC: членство (membership), список NAMES, JOIN/PART и сообщения ---
let ircSock = null;
let ircChannel = null;
let ircReconnect = null;
let ircBuf = '';

function ircSend(s) {
  if (ircSock && ircSock.writable) ircSock.write(s + '\r\n');
}

function ircDisconnect() {
  if (ircReconnect) { clearTimeout(ircReconnect); ircReconnect = null; }
  if (namesSyncTimer) { clearInterval(namesSyncTimer); namesSyncTimer = null; }
  if (ircSock) { try { ircSock.destroy(); } catch {} ircSock = null; }
  onlineViewers.clear();
  initialNamesLoaded = false;
  broadcastViewers();
}

function openIrcSocket() {
  return new Promise((resolve) => {
    const tryTls = (ips) => {
      if (!ips.length) {
        const s = net.connect({ host: 'irc.chat.twitch.tv', port: 6667 });
        s.once('connect', () => resolve(s));
        s.once('error', () => { try { s.destroy(); } catch {} resolve(null); });
        return;
      }
      const ip = ips.shift();
      const s = tls.connect({ host: ip, port: 6697, servername: 'irc.chat.twitch.tv' });
      s.once('secureConnect', () => resolve(s));
      s.once('error', () => { try { s.destroy(); } catch {} tryTls(ips); });
    };
    dns.resolve4('irc.chat.twitch.tv', (err, ips) => {
      tryTls((err || !ips || !ips.length) ? ['irc.chat.twitch.tv'] : Array.from(new Set(ips)));
    });
  });
}

function ircConnect(channel) {
  channel = (channel || '').toLowerCase();
  if (!channel) return;
  if (ircChannel === channel && ircSock) return;
  ircDisconnect();
  ircChannel = channel;
  connect();

  async function connect() {
    const sock = await openIrcSocket();
    if (!sock || ircChannel !== channel || app.quitting) {
      if (ircChannel && !app.quitting) ircReconnect = setTimeout(connect, 5000);
      return;
    }
    sock.setEncoding('utf8');
    sock.on('data', (d) => {
      ircBuf += d;
      let i;
      while ((i = ircBuf.indexOf('\r\n')) >= 0) {
        const line = ircBuf.slice(0, i);
        ircBuf = ircBuf.slice(i + 2);
        try { handleIrcLine(line); } catch {}
      }
    });
    sock.on('error', (e) => { if (CAPTURE_TEST) console.log('[irc] error:', e.message); });
    sock.on('close', () => {
      if (ircSock !== sock) return;
      ircSock = null;
      if (namesSyncTimer) { clearInterval(namesSyncTimer); namesSyncTimer = null; }
      if (ircChannel && !app.quitting) {
        if (CAPTURE_TEST) console.log('[irc] closed, reconnect in 5s');
        ircReconnect = setTimeout(connect, 5000);
      }
    });
    ircSock = sock;
    ircBuf = '';
    // Запрашиваем тэги, команды и членство (membership даёт 353 NAMES, JOIN и PART)
    sock.write('CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership\r\n');
    sock.write('NICK justinfan' + (10000 + Math.floor(Math.random() * 89999)) + '\r\n');
    sock.write('JOIN #' + ircChannel + '\r\n');
    if (CAPTURE_TEST) console.log('[irc] joined #' + ircChannel);

    // Периодическая синхронизация списка зрителей каждые 45 секунд
    if (namesSyncTimer) clearInterval(namesSyncTimer);
    namesSyncTimer = setInterval(() => {
      if (ircSock && ircChannel) ircSend('NAMES #' + ircChannel);
    }, 45000);
  }
}

function parseTags(s) {
  const out = {};
  for (const kv of s.split(';')) {
    const i = kv.indexOf('=');
    if (i <= 0) continue;
    out[kv.slice(0, i)] = kv.slice(i + 1)
      .replace(/\\s/g, ' ')
      .replace(/\\:/g, ';')
      .replace(/\\\\/g, '\\');
  }
  return out;
}

function handleIrcLine(line) {
  if (!line) return;
  if (line.startsWith('PING')) { ircSend('PONG :tmi.twitch.tv'); return; }

  // 1. RPL_NAMREPLY (353): список всех пользователей в комнате Twitch
  if (line.includes(' 353 ')) {
    const idx = line.lastIndexOf(':');
    if (idx >= 0) {
      const rawNicks = line.slice(idx + 1).split(/\s+/);
      let changed = false;
      for (const r of rawNicks) {
        const u = r.trim().toLowerCase();
        if (!u || u.startsWith('justinfan')) continue;
        if (!onlineViewers.has(u)) {
          onlineViewers.set(u, { username: u, displayName: r.trim(), joinedAt: Date.now() });
          changed = true;
          if (initialNamesLoaded) {
            checkUserArrivalAlert(u, r.trim());
          }
        }
      }
      if (changed) broadcastViewers();
    }
    return;
  }

  // 2. RPL_ENDOFNAMES (366): окончание списка NAMES
  if (line.includes(' 366 ')) {
    initialNamesLoaded = true;
    broadcastViewers();
    return;
  }

  // 3. JOIN: пользователь зашел на стрим/чат
  const joinMatch = line.match(/^:([^!]+)![^@]+@[^ ]+\.tmi\.twitch\.tv JOIN #([a-z0-9_]+)$/i) || line.match(/:([^!]+)!.* JOIN #/i);
  if (joinMatch) {
    const rawNick = joinMatch[1].trim();
    const u = rawNick.toLowerCase();
    if (!u.startsWith('justinfan')) {
      const isNew = !onlineViewers.has(u);
      onlineViewers.set(u, { username: u, displayName: rawNick, joinedAt: Date.now() });
      if (initialNamesLoaded && isNew) {
        checkUserArrivalAlert(u, rawNick);
      }
      broadcastViewers();
    }
    return;
  }

  // 4. PART: пользователь покинул стрим/чат
  const partMatch = line.match(/^:([^!]+)![^@]+@[^ ]+\.tmi\.twitch\.tv PART #([a-z0-9_]+)$/i) || line.match(/:([^!]+)!.* PART #/i);
  if (partMatch) {
    const u = partMatch[1].trim().toLowerCase();
    if (onlineViewers.has(u)) {
      onlineViewers.delete(u);
      broadcastViewers();
    }
    return;
  }

  // 5. PRIVMSG: сообщение в чате
  let tags = {};
  let rest = line;
  if (line.startsWith('@')) {
    const sp = line.indexOf(' ');
    if (sp > 0) {
      tags = parseTags(line.slice(1, sp));
      rest = line.slice(sp + 1);
    }
  }

  const m = rest.match(/^:([^!]+)![^ ]* PRIVMSG #([^ ]+) :([\s\S]*)$/) || rest.match(/^[^ ]+ PRIVMSG #([^ ]+) :([\s\S]*)$/);
  if (!m) return;

  const nickFromPrefix = (rest.match(/^:([^!]+)!/) || [])[1];
  const displayName = tags['display-name'] || nickFromPrefix || (m ? m[1] : 'anon');
  const u = displayName.toLowerCase();

  if (u && !u.startsWith('justinfan')) {
    const isNew = !onlineViewers.has(u);
    onlineViewers.set(u, { username: u, displayName, joinedAt: Date.now() });
    if (initialNamesLoaded && isNew) {
      checkUserArrivalAlert(u, displayName);
    }
    broadcastViewers();
  }

  const badges = (tags.badges || '').split(',');
  let type = 'nonfollower';
  let isFollower = false;
  for (const b of badges) {
    const k = b.split('/')[0];
    if (k === 'subscriber' || k === 'founder') { type = 'sub'; break; }
    if (k === 'follower') isFollower = true;
  }
  if (type !== 'sub' && isFollower) type = 'follower';
  if (CAPTURE_TEST) console.log('[irc] msg from', displayName, '->', type);
  notifySound(type);
}

// --- область чата: WebContentsView поверх страницы управления ---
function layoutChat() {
  if (!win || !chatView) return;
  const b = win.getContentBounds();
  const top = Math.min(barH, b.height - 40);
  chatView.setBounds({ x: 0, y: top, width: b.width, height: Math.max(40, b.height - top) });
}

function createChatView() {
  chatView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  chatView.setBackgroundColor('#00000000');
  win.contentView.addChildView(chatView);
  const wc = chatView.webContents;

  wc.on('dom-ready', () => {
    try { wc.setZoomFactor(savedZoom); } catch {}
    (async () => {
      try { await wc.insertCSS('html, body { background: transparent !important; }'); } catch {}
      try {
        await wc.insertCSS('.chat-line__message { text-shadow: 0 1px 2px rgba(0,0,0,.9), 0 0 4px rgba(0,0,0,.65) !important; }');
      } catch {}
    })();
  });

  if (CAPTURE_TEST) {
    wc.on('console-message', (...a) => {
      const ev = a[0];
      console.log('[chat]', typeof ev === 'object' && ev && 'message' in ev ? ev.message : a[2]);
    });
  }

  wc.on('did-fail-load', (e, code, desc, _url, isMain) => {
    let c = code, d = desc, main = isMain;
    if (typeof e === 'object' && e && 'errorCode' in e) { c = e.errorCode; d = e.errorDescription; main = e.isMainFrame; }
    if (!main || c === -3 || !win || win.webContents.isDestroyed()) return;
    win.webContents.send('chat:loaderror', d || ('ошибка ' + c));
  });
}

// --- выносная панель статуса стрима (OBS) ---
let obsPanelWin = null;

function openObsPanel() {
  if (obsPanelWin && !obsPanelWin.isDestroyed()) { obsPanelWin.show(); return; }
  const saved = loadSettings();
  obsPanelWin = new BrowserWindow({
    width: 820,
    height: 44,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  if (Number.isFinite(saved.obsPanelX) && Number.isFinite(saved.obsPanelY)) {
    obsPanelWin.setPosition(saved.obsPanelX, saved.obsPanelY);
  }
  obsPanelWin.setAlwaysOnTop(true, 'screen-saver');
  obsPanelWin.setOpacity(cfg.obsPanelOpacity);
  obsPanelWin.setContentProtection(!CAPTURE_TEST); // панель не для зрителей
  obsPanelWin.loadFile('obspanel.html');
  obsPanelWin.on('move', () => {
    const b = obsPanelWin.getPosition();
    saveSettings({ obsPanelX: b[0], obsPanelY: b[1] });
  });
  obsPanelWin.on('closed', () => {
    obsPanelWin = null;
    if (win && !win.webContents.isDestroyed()) win.webContents.send('obs:panel', { open: false });
  });
  if (win && !win.webContents.isDestroyed()) win.webContents.send('obs:panel', { open: true });
}

// --- окно настроек звука и оповещений ---
function openSettings() {
  try {
    if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
    settingsWin = null;
    settingsWin = new BrowserWindow({
      width: 520,
      height: 780,
      resizable: true,
      minimizable: false,
      maximizable: false,
      alwaysOnTop: true,
      backgroundColor: '#1f1f23',
      autoHideMenuBar: true,
      title: 'Настройки — Мой чат',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    if (CAPTURE_TEST) {
      settingsWin.setPosition(540, 110);
      settingsWin.setSize(520, 720);
    }
    settingsWin.removeMenu();
    settingsWin.setContentProtection(!CAPTURE_TEST); // окно настроек тоже не для зрителей
    settingsWin.loadFile('settings.html');
    settingsWin.webContents.on('did-finish-load', () => {
      settingsWin.webContents.send('state', { ...state });
      settingsWin.webContents.send('cfg', {
        sound: cfg.sound, volume: cfg.volume, zoom: savedZoom, sounds: { ...cfg.sounds },
        userAlerts: [ ...cfg.userAlerts ], notifyAllArrivals: cfg.notifyAllArrivals,
        allArrivalsSound: cfg.allArrivalsSound, arrivalCooldown: cfg.arrivalCooldown,
        obsHost: cfg.obsHost, obsPort: cfg.obsPort, obsPassword: cfg.obsPassword, obsPanelOpacity: cfg.obsPanelOpacity
      });
      broadcastViewers();
    });
    settingsWin.on('closed', () => { settingsWin = null; });
  } catch (e) {
    if (CAPTURE_TEST) console.log('[settings] open failed:', e.message);
    settingsWin = null;
  }
}

function createWindow() {
  const saved = loadSettings();
  const opts = {
    width: saved.width || 430,
    height: saved.height || 720,
    minWidth: 240,
    minHeight: 220,
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    title: 'Мой чат (невидим для стрима)',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  };
  if (CAPTURE_TEST) {
    opts.x = 120; opts.y = 120; opts.width = 430; opts.height = 680;
  } else {
    if (Number.isFinite(saved.x)) opts.x = saved.x;
    if (Number.isFinite(saved.y)) opts.y = saved.y;
  }

  win = new BrowserWindow(opts);
  win.removeMenu();
  if (CAPTURE_TEST) {
    win.webContents.on('console-message', (...a) => {
      const ev = a[0];
      console.log('[renderer]', typeof ev === 'object' && ev && 'message' in ev ? ev.message : a[2] || a[1]);
    });
  }
  applyState();
  win.loadFile('index.html');
  win.on('resize', () => { saveBounds(); layoutChat(); });
  win.on('move', saveBounds);
  win.on('close', (e) => {
    if (!app.quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => { win = null; chatView = null; });
}

function trayIcon() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  if (!img.isEmpty()) return img;
  const exe = nativeImage.createFromPath(process.execPath);
  if (!exe.isEmpty()) return exe;
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4] = 0xff; buf[i * 4 + 1] = 0x47; buf[i * 4 + 2] = 0x91; buf[i * 4 + 3] = 0xff;
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function obsAutoCfg() {
  const c = { host: cfg.obsHost, port: cfg.obsPort, password: cfg.obsPassword };
  const untouched = c.host === '127.0.0.1' && c.port === 4455 && !c.password;
  if (untouched) {
    try {
      const f = path.join(app.getPath('appData'), 'obs-studio', 'plugin_config', 'obs-websocket', 'config.json');
      const o = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (Number(o.server_port) > 0) c.port = Number(o.server_port);
      if (o.server_password) c.password = o.server_password;
    } catch {}
  }
  return c;
}

app.whenReady().then(() => {
  app.setName('obs-hidden-chat');
  const saved = loadSettings();
  if ('topmost' in saved) state.topmost = !!saved.topmost;
  if (Number.isFinite(saved.opacity)) state.opacity = Math.min(1, Math.max(0.2, saved.opacity));
  if (Number.isFinite(saved.zoom)) savedZoom = Math.min(2, Math.max(0.5, saved.zoom));
  mergeCfg(saved);
  createWindow();

  tray = new Tray(trayIcon());
  tray.setToolTip('Мой чат — невидим для стрима');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Настройки', click: openSettings },
    { label: 'Показать', click: showWindow },
    { label: 'Скрыть', click: () => { if (win) win.hide(); } },
    { type: 'separator' },
    { label: 'Выход', click: () => { app.quitting = true; app.quit(); } }
  ]));
  tray.on('double-click', showWindow);

  globalShortcut.register('Alt+Shift+H', () => {
    if (!win) return;
    if (win.isVisible()) win.hide();
    else showWindow();
  });
  globalShortcut.register('Alt+Shift+C', () => {
    state.clickThrough = !state.clickThrough;
    applyState();
  });
  const adjustOpacity = (delta) => {
    state.opacity = Math.min(1, Math.max(0.2, +(state.opacity + delta).toFixed(2)));
    applyState();
    saveSettings({ opacity: state.opacity });
  };
  globalShortcut.register('Alt+Shift+Up', () => adjustOpacity(+0.1));
  globalShortcut.register('Alt+Shift+Down', () => adjustOpacity(-0.1));

  ipcMain.handle('chat:get-init', () => ({ state: { ...state }, saved, captureTest: CAPTURE_TEST }));
  ipcMain.on('chat:set-state', (_e, patch) => {
    for (const k of ['topmost', 'hiddenFromCapture', 'opacity', 'clickThrough']) {
      if (k in patch) state[k] = patch[k];
    }
    applyState();
    saveSettings({ topmost: state.topmost, opacity: state.opacity });
  });
  ipcMain.on('chat:save', (_e, patch) => saveSettings(patch));
  ipcMain.on('chat:win', (_e, a) => {
    if (!win) return;
    if (a === 'min') win.minimize();
    if (a === 'hide') win.hide();
  });
  ipcMain.on('chat:bar', (_e, h) => {
    if (Number.isFinite(h)) {
      barH = Math.max(0, h);
      layoutChat();
    }
  });
  ipcMain.on('chat:load', (_e, url) => {
    if (!/^https?:\/\//.test(url || '')) return;
    currentUrl = url;
    loginMode = false;
    stopLoginPoll();
    if (!chatView) createChatView();
    layoutChat();
    chatView.webContents.loadURL(url).catch(() => {});
    const m = url.match(/popout\/([^\/]+)\/chat/);
    if (m) ircConnect(m[1]);
  });
  ipcMain.on('chat:login', () => {
    if (!chatView) createChatView();
    layoutChat();
    loginMode = true;
    startLoginPoll();
    chatView.webContents.loadURL('https://www.twitch.tv/login').catch(() => {});
  });
  ipcMain.on('chat:zoom', (_e, z) => {
    if (!Number.isFinite(z)) return;
    savedZoom = Math.min(2, Math.max(0.5, z));
    if (chatView) { try { chatView.webContents.setZoomFactor(savedZoom); } catch {} }
    saveSettings({ zoom: savedZoom });
  });
  ipcMain.on('chat:reload', () => {
    if (chatView && currentUrl) chatView.webContents.reload();
  });

  // Настройки
  ipcMain.handle('cfg:get', () => ({
    sound: cfg.sound, volume: cfg.volume, zoom: savedZoom, sounds: { ...cfg.sounds },
    userAlerts: [ ...cfg.userAlerts ], notifyAllArrivals: cfg.notifyAllArrivals,
    allArrivalsSound: cfg.allArrivalsSound, arrivalCooldown: cfg.arrivalCooldown,
    obsHost: cfg.obsHost, obsPort: cfg.obsPort, obsPassword: cfg.obsPassword, obsPanelOpacity: cfg.obsPanelOpacity
  }));
  ipcMain.on('cfg:set', (_e, patch) => saveSettings(patch || {}));
  ipcMain.on('cfg:open', openSettings);
  ipcMain.on('obs:panel:toggle', () => {
    if (obsPanelWin && !obsPanelWin.isDestroyed()) obsPanelWin.close();
    else openObsPanel();
  });

  // Диалог выбора своего аудиофайла
  ipcMain.handle('sound:browse-file', async () => {
    const parent = settingsWin && !settingsWin.isDestroyed() ? settingsWin : win;
    const res = await dialog.showOpenDialog(parent, {
      title: 'Выбрать аудиофайл для оповещения',
      properties: ['openFile'],
      filters: [
        { name: 'Аудиофайлы (*.mp3, *.wav, *.ogg, *.m4a, *.aac, *.flac)', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'] },
        { name: 'Все файлы (*.*)', extensions: ['*'] }
      ]
    });
    if (!res.canceled && res.filePaths.length > 0) {
      return res.filePaths[0];
    }
    return null;
  });

  // Чтение аудиофайла в ArrayBuffer для Web Audio API
  ipcMain.handle('sound:read-buffer', async (_e, filePath) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) return null;
      const buf = await fs.promises.readFile(filePath);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    } catch (e) {
      console.warn('[main] sound:read-buffer failed for', filePath, e.message);
      return null;
    }
  });

  // Онлайн-зрители
  ipcMain.handle('viewers:get', () => ({
    count: onlineViewers.size,
    viewers: Array.from(onlineViewers.values()).sort((a, b) => a.username.localeCompare(b.username))
  }));
  ipcMain.on('viewers:refresh', () => {
    if (ircSock && ircChannel) ircSend('NAMES #' + ircChannel);
  });

  // OBS-статус
  obs.on('log', (m) => { if (CAPTURE_TEST) console.log('[obs]', m); });
  obs.on('status', () => {
    const payload = obs.getStatus();
    if (win && !win.webContents.isDestroyed()) win.webContents.send('obs:status', payload);
    if (obsPanelWin && !obsPanelWin.isDestroyed()) obsPanelWin.webContents.send('obs:status', payload);
  });
  obs.start(obsAutoCfg);

  if (CAPTURE_TEST) {
    onlineViewers.set('streamer_friend', { username: 'streamer_friend', displayName: 'StreamerFriend', joinedAt: Date.now() });
    onlineViewers.set('moderator_alex', { username: 'moderator_alex', displayName: 'Moderator_Alex', joinedAt: Date.now() });
    onlineViewers.set('vip_viewer', { username: 'vip_viewer', displayName: 'VIP_Viewer', joinedAt: Date.now() });
    onlineViewers.set('cool_gamer99', { username: 'cool_gamer99', displayName: 'Cool_Gamer99', joinedAt: Date.now() });
    onlineViewers.set('night_owl', { username: 'night_owl', displayName: 'Night_Owl', joinedAt: Date.now() });
    onlineViewers.set('anna_play', { username: 'anna_play', displayName: 'Anna_Play', joinedAt: Date.now() });
    initialNamesLoaded = true;
    broadcastViewers();

    if (!cfg.userAlerts || cfg.userAlerts.length === 0) {
      cfg.userAlerts = [
        { id: '1', username: 'streamer_friend', sound: 'custom', customSoundPath: 'C:\\Sounds\\vip_alert.mp3', enabled: true },
        { id: '2', username: 'moderator_alex', sound: 'bell', customSoundPath: '', enabled: true }
      ];
    }

    setTimeout(openSettings, 800);
    setTimeout(openObsPanel, 1200);
    setTimeout(() => {
      if (win && !win.webContents.isDestroyed()) {
        win.webContents.executeJavaScript('toggleViewersBox(true)');
      }
    }, 1500);
  }
});

// --- логин в Twitch (возврат в чат по факту появления auth-token) ---
let loginPoll = null;

function stopLoginPoll() {
  if (loginPoll) { clearInterval(loginPoll); loginPoll = null; }
}

function startLoginPoll() {
  stopLoginPoll();
  let ticks = 0;
  loginPoll = setInterval(async () => {
    if (!loginMode || !chatView) { stopLoginPoll(); return; }
    if (++ticks > 300) { loginMode = false; stopLoginPoll(); return; }
    try {
      const cookies = await chatView.webContents.session.cookies.get({ domain: 'twitch.tv' });
      const auth = cookies.find((c) => c.name === 'auth-token' && c.value && c.value.length > 10);
      if (auth && currentUrl) {
        loginMode = false;
        stopLoginPoll();
        chatView.webContents.loadURL(currentUrl).catch(() => {});
      }
    } catch { stopLoginPoll(); }
  }, 2000);
}

app.on('web-contents-created', (_e, wc) => {
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
});

app.on('before-quit', () => { app.quitting = true; });
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  ircDisconnect();
  obs.stop();
});
