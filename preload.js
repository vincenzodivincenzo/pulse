const { contextBridge, ipcRenderer } = require('electron');

const on = (ch) => (fn) => ipcRenderer.on(ch, (_e, data) => fn(data));

contextBridge.exposeInMainWorld('pulse', {
  // Bluetooth
  onDevices: on('ble:devices'),
  setScanMode: (mode) => ipcRenderer.invoke('ble:mode', mode),
  pick: (id) => ipcRenderer.send('ble:pick', id),
  cancelScan: () => ipcRenderer.send('ble:cancel'),
  forget: () => ipcRenderer.send('ble:forget'),
  // Network input
  onNetHr: on('net:hr'),
  onNetStatus: on('net:status'),
  netStatus: () => ipcRenderer.invoke('net:status'),
  netStart: () => ipcRenderer.invoke('net:start'),
  netStop: () => ipcRenderer.invoke('net:stop'),
  netNewToken: () => ipcRenderer.invoke('net:newToken'),
  copy: (text) => ipcRenderer.send('copy', text),
  // Recording
  recStart: (meta) => ipcRenderer.invoke('rec:start', meta),
  recRow: (row) => ipcRenderer.send('rec:row', row),
  recMarkers: (markers) => ipcRenderer.send('rec:markers', markers),
  recStop: (opts) => ipcRenderer.invoke('rec:stop', opts),
  // Registry
  onRegistryChanged: on('registry:changed'),
  registryList: () => ipcRenderer.invoke('registry:list'),
  sessionLoad: (dir) => ipcRenderer.invoke('session:load', dir),
  sessionReanalyze: (dir, profile) => ipcRenderer.invoke('session:reanalyze', dir, profile),
  sessionUpdate: (dir, patch) => ipcRenderer.invoke('session:update', dir, patch),
  sessionTrash: (dir, name) => ipcRenderer.invoke('session:trash', dir, name),
  savePng: (dir, dataUrl, name) => ipcRenderer.invoke('png:save', dir, dataUrl, name),
  savePngTest: (dataUrl) => ipcRenderer.invoke('png:saveTest', dataUrl),
  reveal: (p) => ipcRenderer.send('reveal', p),
  openFolder: () => ipcRenderer.send('open-folder'),
  // App
  getState: () => ipcRenderer.invoke('state:get'),
  setState: (patch) => ipcRenderer.invoke('state:set', patch),
  pin: (on) => ipcRenderer.send('pin', on),
  tray: (text) => ipcRenderer.send('tray', text),
  debug: (msg) => ipcRenderer.send('debug', msg),
});
