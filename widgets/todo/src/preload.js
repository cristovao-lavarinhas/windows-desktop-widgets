'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('todoApi', {
  load: () => ipcRenderer.invoke('todos:load'),
  save: (tasks) => ipcRenderer.invoke('todos:save', tasks),
  openMenu: () => ipcRenderer.send('widget:context-menu'),
  onChanged: (callback) => ipcRenderer.on('todos:changed', (_event, tasks) => callback(tasks)),
  onFocusInput: (callback) => ipcRenderer.on('todo:focus-input', () => callback()),
  onPointer: (callback) => ipcRenderer.on('pointer:move', (_event, data) => callback(data)),
});
