'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('host', {
  getState: () => ipcRenderer.invoke('get-state'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  regeneratePin: () => ipcRenderer.invoke('regen-pin'),
  createVirtualDisplay: (opts) => ipcRenderer.invoke('vd-create', opts),
  removeVirtualDisplay: () => ipcRenderer.invoke('vd-remove'),
  fixSetup: (id) => ipcRenderer.invoke('fix-setup', id),
  setLaunchAtLogin: (on) => ipcRenderer.invoke('set-login', on),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onSessionStart: (cb) => ipcRenderer.on('session-start', (_e, d) => cb(d)),
  onSessionEnd: (cb) => ipcRenderer.on('session-end', (_e, d) => cb(d)),
  onSignal: (cb) => ipcRenderer.on('signal', (_e, d) => cb(d)),
  sendSignal: (sessionId, data) => ipcRenderer.send('signal', { sessionId, data }),
  sendStats: (sessionId, stats) => ipcRenderer.send('stats', { sessionId, stats })
});
