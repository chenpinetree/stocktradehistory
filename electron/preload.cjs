const { contextBridge, ipcRenderer } = require("electron");

const api = {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (payload) => ipcRenderer.invoke("settings:save", payload),
  createTrade: (payload) => ipcRenderer.invoke("trade:create", payload),
  createTradesBulk: (payload) => ipcRenderer.invoke("trade:create-bulk", payload),
  updateTrade: (payload) => ipcRenderer.invoke("trade:update", payload),
  deleteTrade: (payload) => ipcRenderer.invoke("trade:delete", payload),
  clearAllTrades: (payload) => ipcRenderer.invoke("trade:clear-all", payload),
  listTrades: () => ipcRenderer.invoke("trade:list"),
  getSummary: () => ipcRenderer.invoke("summary:get"),
  listSellMatches: () => ipcRenderer.invoke("summary:matches"),
  extractFromImage: (payload) => ipcRenderer.invoke("ai:extract", payload),
  extractFromFile: (payload) => ipcRenderer.invoke("ai:extract-file", payload),
  pollStock: (payload) => ipcRenderer.invoke("stock:poll", payload),
  stockTimeline: (payload) => ipcRenderer.invoke("stock:timeline", payload),
  searchStocks: (payload) => ipcRenderer.invoke("stock:search", payload),
  requestAIAnalysis: (payload) => ipcRenderer.invoke("ai:analyze", payload),
  listAIReports: (payload) => ipcRenderer.invoke("ai:reports", payload),
  deleteAIReport: (payload) => ipcRenderer.invoke("ai:report-delete", payload),
  exportBackupJson: () => ipcRenderer.invoke("backup:export-json"),
  importBackupJson: (payload) => ipcRenderer.invoke("backup:import-json", payload),
};

contextBridge.exposeInMainWorld("api", Object.freeze(api));
