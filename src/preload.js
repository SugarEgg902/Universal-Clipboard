const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listDays: () => ipcRenderer.invoke('clipboard:listDays'),
  listByDay: (dateKey) => ipcRenderer.invoke('clipboard:listByDay', dateKey),
  search: (keyword) => ipcRenderer.invoke('clipboard:search', keyword),
  deleteClip: (id) => ipcRenderer.invoke('clipboard:delete', id),
  clearDay: (dateKey) => ipcRenderer.invoke('clipboard:clearDay', dateKey),
  copyClip: (id) => ipcRenderer.invoke('clipboard:copy', id),
  listSnippets: () => ipcRenderer.invoke('clipboard:listSnippets'),
  pinClip: (id, trigger, groupName) => ipcRenderer.invoke('clipboard:pin', id, trigger, groupName),
  unpinClip: (id) => ipcRenderer.invoke('clipboard:unpin', id),
  pasteSnippet: (id) => ipcRenderer.invoke('clipboard:pasteSnippet', id),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  onWindowShown: (callback) => ipcRenderer.on('window-shown', () => callback()),
  petDrag: (dx, dy) => ipcRenderer.invoke('pet:drag', dx, dy),
  petDragEnd: () => ipcRenderer.invoke('pet:drag-end'),
  petOpenMain: () => ipcRenderer.invoke('pet:open-main'),
  petContextMenu: () => ipcRenderer.invoke('pet:context-menu'),
  onPetClip: (callback) => ipcRenderer.on('pet:clip', (_e, payload) => callback(payload)),
  onPetEmoji: (callback) => ipcRenderer.on('pet:emoji', (_e, emoji) => callback(emoji)),
});
