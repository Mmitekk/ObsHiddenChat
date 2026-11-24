const $ = (id) => document.getElementById(id);
let cfg = null;
let ready = false;

function currentSound(key) {
  let v = cfg.sounds[key] || (key === 'common' ? 'ping' : 'inherit');
  if ((key !== 'common') && (v === 'inherit' || v == null)) v = 'inherit';
  return v;
}

function fillSoundSelect(selectEl, selectedVal, includeInherit = false) {
  selectEl.innerHTML = '';
  if (includeInherit) selectEl.appendChild(new Option('Как общий', 'inherit'));
  for (const [v, label] of window.SoundBank.names) selectEl.appendChild(new Option(label, v));
  selectEl.appendChild(new Option('Кастомный файл...', 'custom'));
  selectEl.appendChild(new Option('Тишина', 'none'));
  selectEl.value = selectedVal || 'ping';
}

function refreshUi() {
  if (!cfg || !ready) return;
  // звук
  $('master').checked = !!cfg.sound;
  const v = Math.round((cfg.volume == null ? 0.7 : cfg.volume) * 100);
  $('volume').value = v;
  $('volval').textContent = v + '%';
  $('sel-common').value = currentSound('common');
  $('sel-sub').value = currentSound('sub');
  $('sel-follower').value = currentSound('follower');
  $('sel-nonfollower').value = currentSound('nonfollower');

  // оповещения о зрителях
  $('notify-all').checked = !!cfg.notifyAllArrivals;
  $('row-all-sound').style.display = cfg.notifyAllArrivals ? 'flex' : 'none';
  $('sel-all-arrivals').value = cfg.allArrivalsSound || 'ping';
  $('arrival-cooldown').value = cfg.arrivalCooldown || 60;

  renderUserAlerts();
}

function refreshState(st) {
  if (!ready) return;
  $('st-topmost').checked = !!st.topmost;
  $('st-protect').checked = !!st.hiddenFromCapture;
  $('st-clickthru').checked = !!st.clickThrough;
  const op = Math.round((st.opacity == null ? 1 : st.opacity) * 100);
  $('st-opacity').value = op;
  $('opval').textContent = op + '%';
}

function saveUserAlerts() {
  if (!cfg) return;
  window.chatApi.cfgSet({ userAlerts: cfg.userAlerts });
}

function renderUserAlerts() {
  const container = $('user-alerts-list');
  container.innerHTML = '';

  const list = Array.isArray(cfg.userAlerts) ? cfg.userAlerts : [];
  if (list.length === 0) {
    container.innerHTML = '<div style="color:#777; font-size:12px; padding:10px; text-align:center; border:1px dashed #333; border-radius:4px;">Список пуст. Нажми «+ Добавить пользователя», чтобы настроить звук при его входе на стрим.</div>';
    return;
  }

  list.forEach((item, index) => {
    const card = document.createElement('div');
    card.className = 'user-card';

    // 1. Верхняя строка: ник, выбор звука, тест, вкл, удалить
    const row = document.createElement('div');
    row.className = 'card-row';

    const uInput = document.createElement('input');
    uInput.type = 'text';
    uInput.placeholder = 'ник пользователя';
    uInput.value = item.username || '';
    uInput.style.flex = '1 1 120px';
    uInput.onchange = () => {
      item.username = uInput.value.trim().toLowerCase();
      saveUserAlerts();
    };

    const sSelect = document.createElement('select');
    sSelect.style.flex = '1 1 140px';
    fillSoundSelect(sSelect, item.sound || 'custom', false);
    sSelect.onchange = () => {
      item.sound = sSelect.value;
      customRow.style.display = item.sound === 'custom' ? 'flex' : 'none';
      saveUserAlerts();
    };

    const testBtn = document.createElement('button');
    testBtn.textContent = '▶';
    testBtn.title = 'Прослушать звук';
    testBtn.onclick = () => {
      window.SoundBank.playAlert(item.sound, item.customSoundPath, cfg.volume);
    };

    const togLabel = document.createElement('label');
    togLabel.className = 'tog';
    togLabel.title = 'Включить / отключить оповещение';
    const togCb = document.createElement('input');
    togCb.type = 'checkbox';
    togCb.checked = item.enabled !== false;
    togCb.onchange = () => {
      item.enabled = togCb.checked;
      saveUserAlerts();
    };
    togLabel.appendChild(togCb);

    const delBtn = document.createElement('button');
    delBtn.className = 'danger';
    delBtn.textContent = '✕';
    delBtn.title = 'Удалить';
    delBtn.onclick = () => {
      cfg.userAlerts.splice(index, 1);
      saveUserAlerts();
      renderUserAlerts();
    };

    row.appendChild(uInput);
    row.appendChild(sSelect);
    row.appendChild(testBtn);
    row.appendChild(togLabel);
    row.appendChild(delBtn);
    card.appendChild(row);

    // 2. Строка выбора кастомного файла (если выбран 'custom')
    const customRow = document.createElement('div');
    customRow.className = 'card-custom';
    customRow.style.display = (item.sound === 'custom') ? 'flex' : 'none';

    const pathInput = document.createElement('input');
    pathInput.type = 'text';
    pathInput.className = 'custom-path';
    pathInput.placeholder = 'Путь к аудиофайлу (.mp3, .wav, .ogg, .m4a)...';
    pathInput.value = item.customSoundPath || '';
    pathInput.onchange = () => {
      item.customSoundPath = pathInput.value.trim();
      saveUserAlerts();
    };

    const browseBtn = document.createElement('button');
    browseBtn.textContent = 'Обзор...';
    browseBtn.title = 'Выбрать аудиофайл на диске';
    browseBtn.onclick = async () => {
      const selected = await window.chatApi.soundBrowseFile();
      if (selected) {
        pathInput.value = selected;
        item.customSoundPath = selected;
        saveUserAlerts();
      }
    };

    customRow.appendChild(pathInput);
    customRow.appendChild(browseBtn);
    card.appendChild(customRow);

    container.appendChild(card);
  });
}

function fillMessageSelect(id, key) {
  const s = $(id);
  s.innerHTML = '';
  if (key !== 'common') s.appendChild(new Option('Как общий', 'inherit'));
  for (const [v, label] of window.SoundBank.names) s.appendChild(new Option(label, v));
  s.appendChild(new Option('Тишина', 'none'));
  s.value = currentSound(key);
  s.onchange = () => {
    cfg.sounds[key] = s.value;
    window.chatApi.cfgSet({ sounds: cfg.sounds });
  };
}

(async () => {
  cfg = await window.chatApi.cfgGet();
  cfg.sounds = cfg.sounds || {};
  cfg.userAlerts = cfg.userAlerts || [];

  fillMessageSelect('sel-common', 'common');
  fillMessageSelect('sel-sub', 'sub');
  fillMessageSelect('sel-follower', 'follower');
  fillMessageSelect('sel-nonfollower', 'nonfollower');

  fillSoundSelect($('sel-all-arrivals'), cfg.allArrivalsSound || 'ping', false);

  const zi = Math.round((cfg.zoom == null ? 1 : cfg.zoom) * 100);
  $('zoomval').textContent = zi + '%';
  $('obs-host').value = cfg.obsHost || '127.0.0.1';
  $('obs-port').value = cfg.obsPort || 4455;
  $('obs-pass').value = cfg.obsPassword || '';
  const op = Math.round((cfg.obsPanelOpacity == null ? 0.9 : cfg.obsPanelOpacity) * 100);
  $('obs-op').value = op;
  $('obsv').textContent = op + '%';

  ready = true;
  refreshUi();

  // Получаем начальное число зрителей
  try {
    const vInfo = await window.chatApi.viewersGet();
    if (vInfo && typeof vInfo.count === 'number') {
      $('viewers-count-badge').textContent = vInfo.count;
    }
  } catch {}

  window.chatApi.onViewers((v) => {
    if (v && typeof v.count === 'number') {
      $('viewers-count-badge').textContent = v.count;
    }
  });

  window.chatApi.onCfg((c) => {
    cfg = c;
    if (c.sounds) cfg.sounds = c.sounds;
    if (c.userAlerts) cfg.userAlerts = c.userAlerts;
    refreshUi();
    if (c.zoom != null) $('zoomval').textContent = Math.round(c.zoom * 100) + '%';
  });

  window.chatApi.onState(refreshState);

  // Окно
  $('st-topmost').onchange = (e) => window.chatApi.setState({ topmost: e.target.checked });
  $('st-protect').onchange = (e) => window.chatApi.setState({ hiddenFromCapture: e.target.checked });
  $('st-clickthru').onchange = (e) => window.chatApi.setState({ clickThrough: e.target.checked });
  $('st-opacity').oninput = (e) => window.chatApi.setState({ opacity: e.target.value / 100 });
  $('zoomin').onclick = () => window.chatApi.send('chat:zoom', +(((cfg.zoom || 1) + 0.1).toFixed(2)));
  $('zoomout').onclick = () => window.chatApi.send('chat:zoom', +(((cfg.zoom || 1) - 0.1).toFixed(2)));
  $('btn-login').onclick = () => window.chatApi.send('chat:login');

  // OBS
  $('obs-host').onchange = (e) => window.chatApi.cfgSet({ obsHost: e.target.value });
  $('obs-port').onchange = (e) => window.chatApi.cfgSet({ obsPort: Number(e.target.value) });
  $('obs-pass').onchange = (e) => window.chatApi.cfgSet({ obsPassword: e.target.value });
  $('obs-op').oninput = (e) => {
    $('obsv').textContent = e.target.value + '%';
    window.chatApi.cfgSet({ obsPanelOpacity: e.target.value / 100 });
  };

  // Звук сообщений
  $('master').onchange = (e) => { cfg.sound = e.target.checked; window.chatApi.cfgSet({ sound: cfg.sound }); };
  $('volume').oninput = (e) => {
    cfg.volume = e.target.value / 100;
    $('volval').textContent = e.target.value + '%';
    window.chatApi.cfgSet({ volume: cfg.volume });
  };

  const bindTest = (btnId, key) => {
    $(btnId).onclick = () => {
      let s = currentSound(key);
      if (s === 'inherit') s = currentSound('common');
      if (s === 'none') return;
      window.SoundBank.play(s, cfg.volume);
    };
  };
  bindTest('test-common', 'common');
  bindTest('test-sub', 'sub');
  bindTest('test-follower', 'follower');
  bindTest('test-nonfollower', 'nonfollower');

  // Оповещения о зрителях
  $('notify-all').onchange = (e) => {
    cfg.notifyAllArrivals = e.target.checked;
    $('row-all-sound').style.display = cfg.notifyAllArrivals ? 'flex' : 'none';
    window.chatApi.cfgSet({ notifyAllArrivals: cfg.notifyAllArrivals });
  };

  $('sel-all-arrivals').onchange = (e) => {
    cfg.allArrivalsSound = e.target.value;
    window.chatApi.cfgSet({ allArrivalsSound: cfg.allArrivalsSound });
  };

  $('test-all-arrivals').onclick = () => {
    window.SoundBank.playAlert(cfg.allArrivalsSound || 'ping', null, cfg.volume);
  };

  $('arrival-cooldown').onchange = (e) => {
    const val = Math.max(5, Math.min(600, parseInt(e.target.value, 10) || 60));
    cfg.arrivalCooldown = val;
    $('arrival-cooldown').value = val;
    window.chatApi.cfgSet({ arrivalCooldown: val });
  };

  $('btn-add-user').onclick = () => {
    if (!cfg.userAlerts) cfg.userAlerts = [];
    cfg.userAlerts.push({
      id: Date.now() + '-' + Math.floor(Math.random() * 10000),
      username: '',
      sound: 'custom',
      customSoundPath: '',
      enabled: true
    });
    saveUserAlerts();
    renderUserAlerts();
    // Фокус на новом инпуте
    const inputs = $('user-alerts-list').querySelectorAll('input[type=text]');
    if (inputs.length > 0) inputs[inputs.length - 2].focus();
  };
})();
