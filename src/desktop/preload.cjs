'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const VALID_WIN_CMDS = new Set(['minimize', 'toggleMaximize', 'toggleFullscreen', 'close', 'getState']);

contextBridge.exposeInMainWorld('rosetta', Object.freeze({
  hostMode: 'electron',
  invoke(action, payload = {}) {
    if (typeof action !== 'string' || action.length > 48) {
      return Promise.reject(new Error('ERR_INVALID_ACTION'));
    }
    return ipcRenderer.invoke('rosetta:invoke', action, payload);
  },
  windowControl(cmd) {
    if (typeof cmd !== 'string' || !VALID_WIN_CMDS.has(cmd)) {
      return Promise.reject(new Error('ERR_INVALID_WINDOW_CMD'));
    }
    return ipcRenderer.invoke('rosetta:window', cmd);
  },
  onWindowState(listener) {
    if (typeof listener !== 'function') return () => {};
    const wrapped = (_event, state) => listener({
      maximized: Boolean(state && state.maximized),
      fullscreen: Boolean(state && state.fullscreen)
    });
    ipcRenderer.on('rosetta:window-state', wrapped);
    return () => ipcRenderer.removeListener('rosetta:window-state', wrapped);
  }
}));
