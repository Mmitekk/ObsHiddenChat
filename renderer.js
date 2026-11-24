const $ = (id) => document.getElementById(id);
let zoom = 1;
let viewersList = [];
let trackedUsers = new Set();
let toastTimer = null;

// Высота панели (плюс полоса ошибки и toast, если видны) — чтобы main правильно
// разместил WebContentsView с чатом под панелью
function reportBar() {
  const bar = $('bar');
  const err = $('err');
  const toast = $('arrival-toast');
  const errH = (err && err.style.display === 'block') ? err.offsetHeight : 0;
  const toastH = (toast && toast.style.display === 'block') ? toast.offsetHeight : 0;
  const used = (bar ? bar.offsetHeight : 0) + errH + toastH;
  window.chatApi.send('chat:bar', used);
}

window.addEventListener('resize', reportBar);
if (window.ResizeObserver) {
  const ro = new ResizeObserver(reportBar);
  if ($('bar')) ro.observe($('bar'));
  if ($('err')) ro.observe($('err'));
  if ($('arrival-toast')) ro.observe($('arrival-toast'));
  if ($('viewers-box')) ro.observe($('viewers-box'));
}

function buildUrl(v) {
  v = (v || '').trim();
  if (!v) return '';
  const ch = v.replace(/^.*twitch\.tv\//, '').replace(/[\/?#].*$/, '').trim();
  return 'https://www.twitch.tv/popout/' + ch + '/chat?darkpopout';
}

function loadChat() {
  const url = buildUrl($('src').value);
  if (!/^https?:\/\//.test(url)) return;
  $('err').style.display = 'none';
  reportBar();
  window.chatApi.send('chat:load', url);
  window.chatApi.save({ chatInput: $('src').value.trim() });
}

function togglePanel() {
  const bar = $('bar');
  const min = bar.classList.toggle('min');
  $('collapse').textContent = min ? '▼' : '▲';
  reportBar();
}

function toggleViewersBox(force) {
  const box = $('viewers-box');
  if (!box) return;
  const current = box.style.display === 'flex';
  const next = (force != null) ? !!force : !current;
  box.style.display = next ? 'flex' : 'none';
  reportBar();
  if (next) {
    renderViewersList($('viewers-search').value);
    const search = $('viewers-search');
    if (search) setTimeout(() => search.focus(), 50);
  }
}

function renderViewersList(query) {
  const listEl = $('viewers-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  const q = (query || '').toLowerCase().trim();
  const filtered = viewersList.filter((item) => {
    if (!q) return true;
    const u = (item.username || '').toLowerCase();
    const d = (item.displayName || '').toLowerCase();
    return u.includes(q) || d.includes(q);
  });

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.style.color = '#777';
    empty.style.fontSize = '11px';
    empty.style.padding = '8px';
    empty.style.textAlign = 'center';
    empty.textContent = q ? 'Никто не найден по запросу' : 'Список зрителей пуст или загружается...';
    listEl.appendChild(empty);
    return;
  }

  filtered.forEach((item) => {
    const u = item.username || item.displayName || '';
    const isTracked = trackedUsers.has(u.toLowerCase());

    const row = document.createElement('div');
    row.className = 'viewer-item';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'viewer-name';
    nameSpan.innerHTML = (isTracked ? '<span class="viewer-tracked" title="Отслеживаемый зритель">🔔</span>' : '') +
                         (item.displayName || u);

    const btnTrack = document.createElement('button');
    btnTrack.className = 'btn-track';
    btnTrack.textContent = isTracked ? 'Настроить' : '+ Оповещение';
    btnTrack.title = isTracked ? 'Открыть настройки этого зрителя' : 'Добавить звук при входе этого зрителя';
    btnTrack.onclick = async () => {
      if (!isTracked) {
        // Добавляем зрителя в отслеживаемые
        const cfg = await window.chatApi.cfgGet();
        const alerts = cfg.userAlerts || [];
        alerts.push({
          id: Date.now() + '-' + Math.floor(Math.random() * 10000),
          username: u.toLowerCase(),
          sound: 'custom',
          customSoundPath: '',
          enabled: true
        });
        window.chatApi.cfgSet({ userAlerts: alerts });
      }
      window.chatApi.cfgOpen();
    };

    row.appendChild(nameSpan);
    row.appendChild(btnTrack);
    listEl.appendChild(row);
  });
}

function showArrivalToast(username, displayName) {
  const toast = $('arrival-toast');
  if (!toast) return;
  toast.textContent = `👋 ${displayName || username} зашёл на стрим!`;
  toast.style.display = 'block';
  reportBar();

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.style.display = 'none';
    reportBar();
  }, 4500);
}

(async () => {
  const init = await window.chatApi.init();
  const saved = init.saved || {};

  if (saved.chatInput) $('src').value = saved.chatInput;
  if (saved.zoom) zoom = saved.zoom;

  // Инициализация конфига звуков и отслеживания
  try {
    const cfg = await window.chatApi.cfgGet();
    if (cfg && cfg.userAlerts) {
      trackedUsers = new Set(cfg.userAlerts.map(a => (a.username || '').toLowerCase().trim()));
    }
  } catch {}

  reportBar();
  if ($('src').value.trim()) loadChat();

  // Начальное состояние зрителей
  try {
    const vInfo = await window.chatApi.viewersGet();
    if (vInfo && typeof vInfo.count === 'number') {
      $('viewers-count').textContent = vInfo.count;
      $('viewers-total').textContent = vInfo.count;
      viewersList = vInfo.viewers || [];
    }
  } catch {}

  // Слушатели событий
  window.chatApi.on('chat:notify', (p) => window.SoundBank.play(p.sound, p.volume));

  // Оповещение о входе конкретного или любого зрителя
  window.chatApi.onArrival((p) => {
    if (p.sound && p.sound !== 'none') {
      window.SoundBank.playAlert(p.sound, p.customSoundPath, p.volume);
    }
    showArrivalToast(p.username, p.displayName);
  });

  // Обновление списка онлайн-зрителей
  window.chatApi.onViewers((v) => {
    if (v && typeof v.count === 'number') {
      $('viewers-count').textContent = v.count;
      $('viewers-total').textContent = v.count;
      viewersList = v.viewers || [];
      if ($('viewers-box') && $('viewers-box').style.display === 'flex') {
        renderViewersList($('viewers-search').value);
      }
    }
  });

  // Обновление настроек
  window.chatApi.onCfg((c) => {
    if (c && c.userAlerts) {
      trackedUsers = new Set(c.userAlerts.map(a => (a.username || '').toLowerCase().trim()));
      if ($('viewers-box') && $('viewers-box').style.display === 'flex') {
        renderViewersList($('viewers-search').value);
      }
    }
  });

  window.chatApi.on('chat:loaderror', (desc) => {
    $('err').style.display = 'block';
    $('err').textContent = 'Не удалось загрузить: ' + desc + ' — проверь ник канала.';
    reportBar();
  });

  window.chatApi.on('obs:status', renderObsStrip);
  window.chatApi.on('obs:panel', (p) => {
    $('obsstrip').style.display = p.open ? 'none' : 'flex';
    reportBar();
  });

  function renderObsStrip(s) {
    const dot = $('obs-dot');
    const line = $('obs-line');
    if (!s.connected) {
      dot.className = 'dot';
      line.textContent = 'OBS: нет связи';
      return;
    }
    dot.className = 'dot' + (s.streaming || s.recording ? ' live' : '');
    let t = 'OBS готов';
    if (s.streaming && s.stream) {
      t = 'LIVE ' + (s.stream.timecode || '') + ' · ' + s.stream.bitrateMbps.toFixed(2) + ' Мбит/с · потери ' + s.stream.droppedPct.toFixed(2) + '%';
    }
    if (s.recording && s.record) t += ' · REC ' + (s.record.timecode || '');
    line.textContent = t;
  }

  const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };

  on('go', loadChat);
  $('src').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadChat(); });
  on('reload', () => window.chatApi.send('chat:reload'));
  on('cfg', () => window.chatApi.cfgOpen());
  on('collapse', togglePanel);
  on('wtitle', togglePanel);
  on('wmin', () => window.chatApi.win('min'));
  on('wclose', () => window.chatApi.win('hide'));
  on('obs-pop', () => window.chatApi.send('obs:panel:toggle'));

  // Кнопки панели зрителей
  on('btn-viewers', () => toggleViewersBox());
  on('viewers-close', () => toggleViewersBox(false));
  on('viewers-resync', () => window.chatApi.viewersRefresh());
  $('viewers-search').addEventListener('input', (e) => renderViewersList(e.target.value));

  console.log('renderer ready with viewers tracking and custom arrival sound alerts');
})();
