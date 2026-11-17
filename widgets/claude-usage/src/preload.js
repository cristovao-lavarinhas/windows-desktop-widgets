'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// API mínima exposta ao renderer (sem acesso a Node nem ao ipcRenderer completo).
contextBridge.exposeInMainWorld('widget', {
  ready: () => ipcRenderer.send('widget:ready'),
  openMenu: () => ipcRenderer.send('widget:context-menu'),
  signIn: () => ipcRenderer.send('widget:sign-in'),
  onPointer: (callback) => ipcRenderer.on('pointer:move', (_event, data) => callback(data)),
  onUpdate: (callback) => ipcRenderer.on('usage:update', (_event, data) => callback(data)),
});
