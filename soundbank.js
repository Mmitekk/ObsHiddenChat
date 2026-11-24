// Синтезированные звуки уведомлений + поддержка пользовательских аудиофайлов.
// Используется и в главном окне, и в окне настроек.
(function () {
  const SOUNDS = [
    ['ping', 'Пинг'],
    ['blip', 'Двойной'],
    ['drop', 'Капля'],
    ['bell', 'Колокольчик'],
    ['pop', 'Поп'],
    ['trio', 'Триоль']
  ];

  let ctx = null;
  function ac() {
    if (!ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      ctx = new AudioCtx();
    }
    return ctx;
  }

  function tone(c, out, t0, o) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = o.wave || 'sine';
    osc.frequency.setValueAtTime(o.f0, t0);
    if (o.f1) osc.frequency.exponentialRampToValueAtTime(o.f1, t0 + o.dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(o.gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    osc.connect(g);
    g.connect(out);
    osc.start(t0);
    osc.stop(t0 + o.dur + 0.05);
  }

  function noise(c, out, t0, o) {
    const len = Math.max(1, Math.floor(c.sampleRate * o.dur));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource();
    src.buffer = buf;
    const g = c.createGain();
    g.gain.value = o.gain;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 900;
    f.Q.value = 1.2;
    src.connect(f);
    f.connect(g);
    g.connect(out);
    src.start(t0);
  }

  const RECIPES = {
    ping: (c, out, t) => tone(c, out, t, { f0: 880, dur: 0.22, gain: 0.22 }),
    blip: (c, out, t) => { tone(c, out, t, { f0: 660, dur: 0.09, gain: 0.2 }); tone(c, out, t + 0.1, { f0: 990, dur: 0.1, gain: 0.2 }); },
    drop: (c, out, t) => tone(c, out, t, { f0: 1200, f1: 350, dur: 0.18, gain: 0.25 }),
    bell: (c, out, t) => { tone(c, out, t, { f0: 1318, dur: 0.5, gain: 0.16 }); tone(c, out, t + 0.1, { f0: 1976, dur: 0.35, gain: 0.07 }); },
    pop: (c, out, t) => { noise(c, out, t, { dur: 0.05, gain: 0.3 }); tone(c, out, t, { f0: 320, f1: 180, dur: 0.08, gain: 0.18 }); },
    trio: (c, out, t) => { tone(c, out, t, { f0: 523, dur: 0.09, gain: 0.16 }); tone(c, out, t + 0.1, { f0: 659, dur: 0.09, gain: 0.16 }); tone(c, out, t + 0.2, { f0: 784, dur: 0.14, gain: 0.18 }); }
  };

  const customCache = new Map();

  async function loadAndDecodeCustom(filePath) {
    if (!filePath || !window.chatApi || !window.chatApi.soundReadBuffer) return null;
    if (customCache.has(filePath)) return customCache.get(filePath);
    try {
      const arrayBuf = await window.chatApi.soundReadBuffer(filePath);
      if (!arrayBuf || arrayBuf.byteLength === 0) return null;
      const c = ac();
      // copy buffer since decodeAudioData detaches original ArrayBuffer
      const copy = arrayBuf.slice(0);
      const decoded = await c.decodeAudioData(copy);
      customCache.set(filePath, decoded);
      return decoded;
    } catch (e) {
      console.warn('[soundbank] Failed to load/decode custom audio file:', filePath, e);
      return null;
    }
  }

  async function playCustom(filePath, volume) {
    if (!filePath) return false;
    try {
      const c = ac();
      if (c.state === 'suspended') await c.resume();
      const buf = await loadAndDecodeCustom(filePath);
      if (!buf) return false;
      const src = c.createBufferSource();
      src.buffer = buf;
      const g = c.createGain();
      g.gain.value = Math.max(0, Math.min(1, volume == null ? 0.7 : volume));
      src.connect(g);
      g.connect(c.destination);
      src.start(0);
      return true;
    } catch (e) {
      console.warn('[soundbank] Error playing custom audio:', filePath, e);
      return false;
    }
  }

  window.SoundBank = {
    names: SOUNDS,
    play(name, volume) {
      const r = RECIPES[name];
      if (!r) return;
      try {
        const c = ac();
        if (c.state === 'suspended') c.resume();
        const t = c.currentTime + 0.02;
        const master = c.createGain();
        master.gain.value = Math.max(0, Math.min(1, volume == null ? 0.7 : volume));
        master.connect(c.destination);
        r(c, master, t);
      } catch (e) {}
    },
    playCustom,
    async playAlert(sound, customSoundPath, volume) {
      if (sound === 'custom' && customSoundPath) {
        const ok = await playCustom(customSoundPath, volume);
        if (ok) return;
      }
      const s = (sound && RECIPES[sound]) ? sound : 'ping';
      window.SoundBank.play(s, volume);
    },
    clearCache() {
      customCache.clear();
    }
  };
})();
