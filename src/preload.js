const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listDays: () => ipcRenderer.invoke('clipboard:listDays'),
  listByDay: (dateKey) => ipcRenderer.invoke('clipboard:listByDay', dateKey),
  search: (keyword) => ipcRenderer.invoke('clipboard:search', keyword),
  deleteClip: (id) => ipcRenderer.invoke('clipboard:delete', id),
  clearDay: (dateKey) => ipcRenderer.invoke('clipboard:clearDay', dateKey),
  copyClip: (id) => ipcRenderer.invoke('clipboard:copy', id),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  onWindowShown: (callback) => ipcRenderer.on('window-shown', () => callback()),
});
