type JsonValue = Record<string, unknown>;

function errText(payload: unknown) {
  if (payload && typeof payload === "object" && "error" in payload) {
    return String((payload as { error: unknown }).error);
  }
  return "请求失败";
}

async function post(path: string, payload?: JsonValue) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(errText(data));
  return data;
}

async function get(path: string) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(errText(data));
  return data;
}

function pickJsonFile() {
  return new Promise<File | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = () => resolve(input.files?.[0] || null);
    input.click();
  });
}

function downloadJson(filename: string, obj: unknown) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function timeStamp() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${y}${m}${day}-${hh}${mm}${ss}`;
}

export function installWebApiShim() {
  if (typeof window === "undefined") return;
  if (window.api) return;

  window.api = {
    getSettings: () => get("/api/settings/get"),
    saveSettings: (payload) => post("/api/settings/save", payload as unknown as JsonValue),
    createTrade: (payload) => post("/api/trade/create", payload as unknown as JsonValue),
    createTradesBulk: (payload) => post("/api/trade/create-bulk", payload as unknown as JsonValue),
    updateTrade: (payload) => post("/api/trade/update", payload as unknown as JsonValue),
    deleteTrade: (payload) => post("/api/trade/delete", payload as unknown as JsonValue),
    clearAllTrades: (payload) => post("/api/trade/clear-all", payload as unknown as JsonValue),
    listTrades: () => get("/api/trade/list"),
    getSummary: () => get("/api/summary/get"),
    listSellMatches: () => get("/api/summary/matches"),
    extractFromImage: (payload) => post("/api/ai/extract", payload as unknown as JsonValue),
    extractFromFile: (payload) => post("/api/ai/extract-file", payload as unknown as JsonValue),
    pollStock: (payload) => post("/api/stock/poll", payload as unknown as JsonValue),
    stockTimeline: (payload) => post("/api/stock/timeline", payload as unknown as JsonValue),
    searchStocks: (payload) => post("/api/stock/search", payload as unknown as JsonValue),
    requestAIAnalysis: (payload) => post("/api/ai/analyze", payload as unknown as JsonValue),
    listAIReports: (payload) => post("/api/ai/reports", payload as unknown as JsonValue),
    deleteAIReport: (payload) => post("/api/ai/report-delete", payload as unknown as JsonValue),
    exportBackupJson: async () => {
      const res = await get("/api/backup/export-json");
      if (!res?.ok || !res?.data) return { ok: false, canceled: true };
      const filename = `stock-backup-${timeStamp()}.json`;
      downloadJson(filename, res.data);
      return { ok: true, canceled: false, filePath: filename };
    },
    importBackupJson: async (payload) => {
      const file = await pickJsonFile();
      if (!file) return { ok: false, canceled: true };
      const text = await file.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (_e) {
        throw new Error("备份文件不是有效的 JSON");
      }
      return post("/api/backup/import-json", {
        mode: payload.mode,
        overwriteSecrets: payload.overwriteSecrets,
        data,
      });
    },
  } as Window["api"];
}
