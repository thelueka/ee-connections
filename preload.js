const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getQuestions: () => ipcRenderer.invoke('get-questions'),
  getProgress: () => ipcRenderer.invoke('get-progress'),
  saveAnswer: (data) => ipcRenderer.invoke('save-answer', data),
  getStats: () => ipcRenderer.invoke('get-stats'),
  getLeaderboard: () => ipcRenderer.invoke('get-leaderboard')
});
