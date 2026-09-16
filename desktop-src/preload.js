const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codexRuntime', {
  selectCli: (locale) => ipcRenderer.invoke('runtime:select-cli', locale),
});

contextBridge.exposeInMainWorld('codexUpdater', {
  getState: () => ipcRenderer.invoke('updates:get-state'),
  check: () => ipcRenderer.invoke('updates:check'),
  download: () => ipcRenderer.invoke('updates:download'),
  cancelDownload: () => ipcRenderer.invoke('updates:cancel-download'),
  install: () => ipcRenderer.invoke('updates:install'),
  getCodexState: () => ipcRenderer.invoke('codex-updates:get-state'),
  checkCodex: () => ipcRenderer.invoke('codex-updates:check'),
  installCodexUpdate: (options) => ipcRenderer.invoke('codex-updates:install', options),
  cancelCodexDownload: () => ipcRenderer.invoke('codex-updates:cancel-download'),
  onCodexState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('codex-updates:state', listener);
    return () => ipcRenderer.removeListener('codex-updates:state', listener);
  },
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('updates:state', listener);
    return () => ipcRenderer.removeListener('updates:state', listener);
  },
});

contextBridge.exposeInMainWorld('codexNotifications', {
  show: (payload) => ipcRenderer.invoke('notifications:show', payload),
  importSound: () => ipcRenderer.invoke('notifications:import-sound'),
});

contextBridge.exposeInMainWorld('codexFloating', {
  getSettings: () => ipcRenderer.invoke('floating:get-settings'),
  show: () => ipcRenderer.invoke('floating:show'),
  hide: () => ipcRenderer.invoke('floating:hide'),
  updateSettings: (patch) => ipcRenderer.invoke('floating:update-settings', patch),
  updateLocale: (locale) => ipcRenderer.invoke('floating:update-locale', locale),
  setExpanded: (expanded) => ipcRenderer.invoke('floating:set-expanded', expanded),
  resize: (height) => ipcRenderer.invoke('floating:resize', height),
  onSettings: (callback) => {
    const listener = (_event, settings) => callback(settings);
    ipcRenderer.on('floating:settings', listener);
    return () => ipcRenderer.removeListener('floating:settings', listener);
  },
  onLocale: (callback) => {
    const listener = (_event, locale) => callback(locale);
    ipcRenderer.on('floating:locale', listener);
    return () => ipcRenderer.removeListener('floating:locale', listener);
  },
});
