const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chatApi', {
  init: () => ipcRenderer.invoke('chat:get-init'),
  setState: (patch) => ipcRenderer.send('chat:set-state', patch),
  save: (patch) => ipcRenderer.send('chat:save', patch),
  send: (ch, payload) => ipcRenderer.send(ch, payload),
  on: (ch, cb) => {
    const listener = (_e, p) => cb(p);
    ipcRenderer.on(ch, listener);
    return () => ipcRenderer.removeListener(ch, listener);
  },
  win: (action) => ipcRenderer.send('chat:win', action),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  cfgGet: () => ipcRenderer.invoke('cfg:get'),
  cfgSet: (patch) => ipcRenderer.send('cfg:set', patch),
  cfgOpen: () => ipcRenderer.send('cfg:open'),
  onCfg: (cb) => ipcRenderer.on('cfg', (_e, c) => cb(c)),
  // Custom audio files
  soundBrowseFile: () => ipcRenderer.invoke('sound:browse-file'),
  soundReadBuffer: (filePath) => ipcRenderer.invoke('sound:read-buffer', filePath),
  // Viewers online
  viewersGet: () => ipcRenderer.invoke('viewers:get'),
  viewersRefresh: () => ipcRenderer.send('viewers:refresh'),
  onViewers: (cb) => ipcRenderer.on('viewers:update', (_e, v) => cb(v)),
  onArrival: (cb) => ipcRenderer.on('chat:arrival', (_e, a) => cb(a))
});
