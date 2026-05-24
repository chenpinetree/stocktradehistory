const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { initDb, createTrade, createTradesBulk, updateTrade, deleteTrade, clearAllTrades, listTrades, saveSettings, getSettings, computeSummary, listSellMatches, parseImageWithAI, parseFileWithAI, saveAiReport, listAiReports, deleteAiReport, exportBackupData, importBackupData } = require("./services.cjs");
const { fetchAndParseData, searchStocks, fetchF10Bundle, getMoneyFlowHistory, extractTdxFeatures } = require("./stock-core.cjs");

let mainWindow = null;
const stockCache = new Map();
const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL || "http://localhost:5173";
const STOCK_CACHE_TTL_MS = 60 * 1000;
const STOCK_CACHE_MAX = 300;

function looksBrokenName(name) {
  const s = String(name || "").trim();
  if (!s) return true;
  if (s.includes("�")) return true;
  if (/^[\x00-\x1F\x7F]+$/.test(s)) return true;
  if (/^\d{6}$/.test(s)) return true;
  return false;
}

async function normalizeReportName(code, rawName) {
  const c = String(code || "").trim();
  const n = String(rawName || "").trim();
  const isAsciiSuspicious = /^\d{6}$/.test(c) && n.length > 0 && n.length < 5 && /^[a-zA-Z0-9]+$/.test(n);
  if (!looksBrokenName(n) && !isAsciiSuspicious) return n;
  try {
    const list = await searchStocks(c);
    const exact = list.find((x) => String(x.code) === c);
    if (exact?.name) return String(exact.name).trim();
  } catch (_e) {}
  return n || c;
}

function localDateTimeStamp() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${y}${m}${day}-${hh}${mm}${ss}`;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
    return;
  }
  mainWindow.loadURL(DEV_SERVER_URL);
}

function isTrustedSender(event) {
  const url = String(event?.senderFrame?.url || "");
  if (!url) return false;
  if (url.startsWith("file://")) return true;
  try {
    const dev = new URL(DEV_SERVER_URL);
    const u = new URL(url);
    return u.protocol === dev.protocol && u.hostname === dev.hostname && u.port === dev.port;
  } catch (_e) {
    return false;
  }
}

function secureHandle(channel, handler) {
  ipcMain.handle(channel, async (event, payload) => {
    if (!isTrustedSender(event)) {
      throw new Error("非法调用来源");
    }
    return handler(event, payload);
  });
}

function getStockCache(key) {
  const item = stockCache.get(key);
  if (!item) return null;
  if (Date.now() - item.ts > STOCK_CACHE_TTL_MS) {
    stockCache.delete(key);
    return null;
  }
  stockCache.delete(key);
  stockCache.set(key, item);
  return item.data;
}

function setStockCache(key, data) {
  stockCache.set(key, { data, ts: Date.now() });
  while (stockCache.size > STOCK_CACHE_MAX) {
    const oldestKey = stockCache.keys().next().value;
    if (!oldestKey) break;
    stockCache.delete(oldestKey);
  }
}

app.whenReady().then(() => {
  const dbDir = path.join(os.homedir(), "Library", "Application Support", "stock-trade-local-app");
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, "trade-history.db");
  initDb(dbPath);

  secureHandle("settings:get", () => getSettings());
  secureHandle("settings:save", (_event, payload) => saveSettings(payload));

  secureHandle("trade:create", (_event, payload) => createTrade(payload));
  secureHandle("trade:create-bulk", (_event, payload) => createTradesBulk(payload?.rows));
  secureHandle("trade:update", (_event, payload) => updateTrade(payload));
  secureHandle("trade:delete", (_event, payload) => deleteTrade(payload?.id));
  secureHandle("trade:clear-all", (_event, payload) => clearAllTrades(payload?.confirmText));
  secureHandle("trade:list", () => listTrades());
  secureHandle("summary:get", () => computeSummary());
  secureHandle("summary:matches", () => listSellMatches());

  secureHandle("ai:extract", async (_event, payload) => {
    return parseImageWithAI(payload);
  });
  secureHandle("ai:extract-file", async (_event, payload) => {
    return parseFileWithAI(payload);
  });

  secureHandle("stock:poll", async (_event, payload) => {
    const code = String(payload?.code || "").trim();
    const period = String(payload?.period || "day");
    if (!code) throw new Error("缺少股票代码");
    const cacheKey = `${code}:${period}`;
    const cached = getStockCache(cacheKey);
    if (cached) return cached;
    const data = await fetchAndParseData(code, period);
    setStockCache(cacheKey, data);
    return data;
  });

  secureHandle("stock:timeline", async (_event, payload) => {
    const code = String(payload?.code || "").trim();
    const period = String(payload?.period || "day");
    if (!code) throw new Error("缺少股票代码");
    const cacheKey = `${code}:${period}`;
    const cached = getStockCache(cacheKey);
    if (cached?.kline?.length) return cached.kline;
    const data = await fetchAndParseData(code, period);
    setStockCache(cacheKey, data);
    return data.kline || [];
  });

  secureHandle("stock:search", async (_event, payload) => {
    return searchStocks(String(payload?.keyword || ""));
  });

  secureHandle("ai:analyze", async (_event, payload) => {
    const code = String(payload?.code || "").trim();
    const requestedName = String(payload?.name || "").trim();
    const analysisType = String(payload?.analysisType || "f10");
    if (!code) throw new Error("缺少股票代码");
    if (!["f10", "orderbook"].includes(analysisType)) throw new Error("分析类型不支持");

    const settings = getSettings(true);
    const profiles = Array.isArray(settings.ai_profiles) ? settings.ai_profiles : [];
    const active = profiles.find((p) => p.id === settings.active_ai_profile_id) || profiles[0] || {
      base_url: settings.ai_base_url,
      api_key: settings.ai_api_key,
      model: settings.ai_model,
    };

    if (!active.base_url || !active.api_key || !active.model) {
      throw new Error("请先在 AI 设置中配置并选择可用模型");
    }

    const quote = await fetchAndParseData(code, "day");
    const today = new Date().toISOString().slice(0, 10);
    let systemPrompt = "";
    let userPrompt = "";

    if (analysisType === "f10") {
      const f10 = await fetchF10Bundle(code);
      systemPrompt = `你是顶级的A股股票研究员和金融分析师。日期：${today}`;
      userPrompt = `请对以下股票进行“全解分析”。\n标的：${quote.name}(${code})，现价：${quote.price}。\n\n已抓取资料：\n【东方财富公司资料】\n${f10.companySurvey || "无"}\n\n【东方财富财务分析】\n${f10.financeAnalysis || "无"}\n\n【同花顺基本面】\n${f10.thsText || "无"}\n\n【新浪财经F10】\n${f10.sinaText || "无"}\n\n请必须按以下13个维度逐项输出，每项单独成段，不可遗漏：\n1 最新提示\n2 公司概况\n3 财务分析\n4 股东研究\n5 股本结构\n6 资本运作\n7 业内点评\n8 公司大事\n9 研究报告\n10 经营分析\n11 主力追踪\n12 分红扩股\n13 高层治理`;
    } else {
      const bids = quote.bidAsk || [];
      const buyTotal = bids.reduce((s, x) => s + Number(x.bidVol || 0), 0);
      const sellTotal = bids.reduce((s, x) => s + Number(x.askVol || 0), 0);
      const changePercent = quote.prevClose ? (((quote.price - quote.prevClose) / quote.prevClose) * 100).toFixed(2) : "0.00";
      const moneyFlow = await getMoneyFlowHistory(code);
      const inflowDays = moneyFlow.filter((x) => x.mainNet > 0).length;
      const inflowSum = moneyFlow.reduce((s, x) => s + Number(x.mainNet || 0), 0);
      const tdxText = extractTdxFeatures(quote.kline || []);
      const mfText = `近30日主力净流入天数: ${inflowDays}天; 累计净额: ${inflowSum.toFixed(2)}`;
      systemPrompt = `你是耐心、负责的A股交易讲解员。日期：${today}。
请用“新手也能看懂”的中文解释盘面，不要堆砌术语，不要使用生硬或居高临下的表达。
要求：
1) 先说结论，再说理由；
2) 每段2-3句话，句子短一些；
3) 必须解释术语（如金叉、死叉、放量、缩量）是什么意思；
4) 给出风险提醒，不得给出“保证上涨/下跌”的绝对判断；
5) 输出纯文本，不用Markdown表格。`;
      userPrompt = `请分析这只股票的“盘口情况”，并用通俗语言输出：

股票: ${quote.name}(${code})
现价: ${quote.price}
涨跌幅: ${changePercent}%
买盘总手: ${buyTotal}
卖盘总手: ${sellTotal}
今日主力资金净额: ${quote.mainNetInflow}

技术形态: ${tdxText}
资金变化: ${mfText}

请严格按这个结构输出（标题可微调，但顺序不要变）：
1. 一句话结论（偏强/震荡/偏弱）
2. 现在盘面在发生什么（买卖盘、量价关系，用白话解释）
3. 技术指标怎么看（MA、MACD、GMMA分别代表什么，现在是偏多还是偏空）
4. 资金面怎么看（主力净流入/流出代表什么）
5. 新手操作提醒（分3条：可做什么、不要做什么、什么信号出现再行动）
6. 风险提示（至少2条）

注意：
- 不要只给结论，必须告诉“为什么”；
- 避免“建议重仓、梭哈”这类激进措辞；
- 语言尽量口语化、易懂。`;
    }

    const res = await fetch(`${String(active.base_url).replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${active.api_key}`,
      },
      body: JSON.stringify({
        model: active.model,
        max_tokens: 4096,
        temperature: 0.7,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`AI 分析失败: ${res.status} ${text}`);
    }

    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content || "";
    const normalizedName = await normalizeReportName(code, requestedName || quote.name);
    const output = {
      code,
      name: normalizedName,
      price: quote.price,
      analysis: Array.isArray(content) ? content.map((c) => c?.text || "").join("\n") : String(content),
      analysis_type: analysisType,
    };

    saveAiReport({
      code: output.code,
      name: output.name,
      analysis_type: analysisType,
      content: output.analysis,
    });

    return output;
  });

  secureHandle("ai:reports", (_event, payload) => {
    return listAiReports(String(payload?.code || ""));
  });

  secureHandle("ai:report-delete", (_event, payload) => {
    return deleteAiReport(payload?.id);
  });

  secureHandle("backup:export-json", async () => {
    const backup = exportBackupData();
    const fileName = `stock-backup-${localDateTimeStamp()}.json`;
    const saveRes = await dialog.showSaveDialog(mainWindow, {
      title: "导出数据备份(JSON)",
      defaultPath: path.join(app.getPath("documents"), fileName),
      filters: [{ name: "JSON Files", extensions: ["json"] }],
    });
    if (saveRes.canceled || !saveRes.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(saveRes.filePath, JSON.stringify(backup, null, 2), "utf8");
    return { ok: true, canceled: false, filePath: saveRes.filePath };
  });

  secureHandle("backup:import-json", async (_event, payload) => {
    const mode = String(payload?.mode || "merge").trim().toLowerCase() === "replace" ? "replace" : "merge";
    const overwriteSecrets = Boolean(payload?.overwriteSecrets);
    const openRes = await dialog.showOpenDialog(mainWindow, {
      title: "导入数据备份(JSON)",
      properties: ["openFile"],
      filters: [{ name: "JSON Files", extensions: ["json"] }],
    });
    if (openRes.canceled || !openRes.filePaths?.[0]) return { ok: false, canceled: true };
    const filePath = openRes.filePaths[0];
    const raw = fs.readFileSync(filePath, "utf8");
    let json;
    try {
      json = JSON.parse(raw);
    } catch (_e) {
      throw new Error("备份文件不是有效的 JSON");
    }
    const result = importBackupData({ ...json, mode, overwriteSecrets });
    return { ...result, canceled: false, filePath };
  });

  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
