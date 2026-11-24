const $ = (id) => document.getElementById(id);
const show = (id, on) => { $(id).style.display = on ? 'inline' : 'none'; };

function render(s) {
  const dot = $('dot');
  const state = $('state');

  if (!s.connected) {
    dot.className = 'dot';
    state.textContent = 'нет связи с OBS';
    show('rec', false);
    for (const id of ['seg-bit', 'seg-drop', 'seg-net', 'seg-fps', 'seg-cpu']) show(id, false);
    return;
  }

  let anyLive = false;
  if (s.streaming && s.stream) {
    anyLive = true;
    state.textContent = 'LIVE ' + (s.stream.timecode || '00:00');
  } else if (s.recording && s.record) {
    anyLive = true;
    state.textContent = 'запись';
  } else {
    state.textContent = 'офлайн';
  }
  dot.className = 'dot' + (anyLive ? ' live' : '');

  if (s.recording && s.record) {
    show('rec', true);
    $('rectc').textContent = s.record.timecode || '00:00';
  } else {
    show('rec', false);
  }

  if (s.streaming && s.stream) {
    const d = s.stream;
    show('seg-bit', true);
    $('bitv').textContent = d.bitrateMbps.toFixed(2) + ' Мбит/с';
    show('seg-drop', true);
    $('dropv').textContent = d.droppedPct.toFixed(2) + '%';
    $('dropv').className = d.droppedPct > 1 ? 'bad' : (d.droppedPct > 0.2 ? 'warn' : 'good');
    show('seg-net', true);
    $('netv').textContent = d.quality + (d.reconnecting ? ' (переподкл.)' : '');
    $('netv').className = d.reconnecting ? 'bad' : (d.quality === 'отлично' ? 'good' : (d.quality === 'хорошо' ? '' : 'warn'));
  } else {
    show('seg-bit', false);
    show('seg-drop', false);
    show('seg-net', false);
  }

  show('seg-fps', s.stats.fps != null);
  show('seg-cpu', s.stats.cpu != null);
  if (s.stats.fps != null) $('fpsv').textContent = s.stats.fps;
  if (s.stats.cpu != null) $('cpuv').textContent = s.stats.cpu + '%';
}

window.chatApi.on('obs:status', render);
$('close').onclick = () => window.chatApi.send('obs:panel:toggle');
