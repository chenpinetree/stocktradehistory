const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");
const { URL } = require("node:url");
const { initDb, createTrade, createTradesBulk, updateTrade, deleteTrade, clearAllTrades, listTrades, saveSettings, getSettings, computeSummary, listSellMatches, parseImageWithAI, parseFileWithAI, saveAiReport, listAiReports, deleteAiReport, exportBackupData, importBackupData } = require("../electron/services.cjs");
const { hasAppPassword, setupAppPassword, verifyAppPassword, changeAppPassword } = require("../electron/services.cjs");
const { fetchAndParseData, searchStocks, fetchF10Bundle, getMoneyFlowHistory, extractTdxFeatures } = require("../electron/stock-core.cjs");

const PORT = Number(process.env.PORT || 3737);
const HOST = process.env.HOST || "0.0.0.0";
const APP_DATA_DIR = process.env.APP_DATA_DIR || path.join(process.cwd(), "data");
const DB_PATH = process.env.DB_PATH || path.join(APP_DATA_DIR, "trade-history.db");
const DIST_DIR = path.join(process.cwd(), "dist");

const stockCache = new Map();
const authSessions = new Map();
const STOCK_CACHE_TTL_MS = 60 * 1000;
const STOCK_CACHE_MAX = 300;

function nowDate() {
  return new Date().toISOString().slice(0, 10);
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  });
  res.end(body);
}

function getSessionToken(req) {
  const h = String(req.headers["x-app-session"] || "").trim();
  return h || null;
}

function isAuthorized(req) {
  if (!hasAppPassword()) return true;
  const token = getSessionToken(req);
  if (!token) return false;
  const exp = authSessions.get(token);
  if (!exp || Date.now() > exp) {
    authSessions.delete(token);
    return false;
  }
  authSessions.set(token, Date.now() + 1000 * 60 * 60 * 12);
  return true;
}

function ensureAuthorized(req) {
  if (!isAuthorized(req)) {
    const e = new Error("未登录或会话已过期");
    e.statusCode = 401;
    throw e;
  }
}

function notFound(res) {
  json(res, 404, { error: "Not Found" });
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
    const oldest = stockCache.keys().next().value;
    if (!oldest) break;
    stockCache.delete(oldest);
  }
}

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

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (_e) {
    throw new Error("请求体不是有效 JSON");
  }
}

function mimeOf(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".jpg") || file.endsWith(".jpeg")) return "image/jpeg";
  if (file.endsWith(".ico")) return "image/x-icon";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function serveStatic(reqPath, res) {
  const safePath = reqPath === "/" ? "/index.html" : reqPath;
  const cleaned = path.normalize(safePath).replace(/^\.\.(\/|\\|$)/, "");
  const target = path.join(DIST_DIR, cleaned);
  try {
    const st = await fsp.stat(target);
    if (st.isFile()) {
      const data = await fsp.readFile(target);
      res.writeHead(200, { "Content-Type": mimeOf(target) });
      res.end(data);
      return;
    }
  } catch (_e) {}

  try {
    const index = await fsp.readFile(path.join(DIST_DIR, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(index);
  } catch (_e) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("dist/index.html not found. Please run: npm run build");
  }
}

async function handleApi(req, res, urlObj) {
  const p = urlObj.pathname;
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    });
    res.end();
    return;
  }

  if (p === "/api/health" && req.method === "GET") return json(res, 200, { ok: true });
  if (p === "/api/auth/status" && req.method === "GET") {
    const enabled = hasAppPassword();
    return json(res, 200, { enabled, authenticated: isAuthorized(req) });
  }
  if (p === "/api/auth/setup" && req.method === "POST") {
    const body = await readJsonBody(req);
    setupAppPassword(String(body?.password || ""));
    const token = crypto.randomBytes(24).toString("hex");
    authSessions.set(token, Date.now() + 1000 * 60 * 60 * 12);
    return json(res, 200, { ok: true, sessionToken: token });
  }
  if (p === "/api/auth/login" && req.method === "POST") {
    const body = await readJsonBody(req);
    const ok = verifyAppPassword(String(body?.password || ""));
    if (!ok) {
      const e = new Error("密码错误");
      e.statusCode = 401;
      throw e;
    }
    const token = crypto.randomBytes(24).toString("hex");
    authSessions.set(token, Date.now() + 1000 * 60 * 60 * 12);
    return json(res, 200, { ok: true, sessionToken: token });
  }
  if (p === "/api/auth/logout" && req.method === "POST") {
    const token = getSessionToken(req);
    if (token) authSessions.delete(token);
    return json(res, 200, { ok: true });
  }
  if (p === "/api/auth/change-password" && req.method === "POST") {
    ensureAuthorized(req);
    const body = await readJsonBody(req);
    const result = changeAppPassword(String(body?.oldPassword || ""), String(body?.newPassword || ""));
    return json(res, 200, result);
  }

  ensureAuthorized(req);

  if (p === "/api/settings/get" && req.method === "GET") return json(res, 200, getSettings());
  if (p === "/api/settings/save" && req.method === "POST") return json(res, 200, saveSettings(await readJsonBody(req)));

  if (p === "/api/trade/list" && req.method === "GET") return json(res, 200, listTrades());
  if (p === "/api/trade/create" && req.method === "POST") return json(res, 200, createTrade(await readJsonBody(req)));
  if (p === "/api/trade/create-bulk" && req.method === "POST") {
    const body = await readJsonBody(req);
    return json(res, 200, createTradesBulk(body?.rows));
  }
  if (p === "/api/trade/update" && req.method === "POST") return json(res, 200, updateTrade(await readJsonBody(req)));
  if (p === "/api/trade/delete" && req.method === "POST") {
    const body = await readJsonBody(req);
    return json(res, 200, deleteTrade(body?.id));
  }
  if (p === "/api/trade/clear-all" && req.method === "POST") {
    const body = await readJsonBody(req);
    return json(res, 200, clearAllTrades(body?.confirmText));
  }

  if (p === "/api/summary/get" && req.method === "GET") return json(res, 200, computeSummary());
  if (p === "/api/summary/matches" && req.method === "GET") return json(res, 200, listSellMatches());

  if (p === "/api/ai/extract" && req.method === "POST") return json(res, 200, parseImageWithAI(await readJsonBody(req)));
  if (p === "/api/ai/extract-file" && req.method === "POST") return json(res, 200, parseFileWithAI(await readJsonBody(req)));
  if (p === "/api/ai/reports" && req.method === "POST") {
    const body = await readJsonBody(req);
    return json(res, 200, listAiReports(String(body?.code || "")));
  }
  if (p === "/api/ai/report-delete" && req.method === "POST") {
    const body = await readJsonBody(req);
    return json(res, 200, deleteAiReport(body?.id));
  }

  if (p === "/api/stock/poll" && req.method === "POST") {
    const body = await readJsonBody(req);
    const code = String(body?.code || "").trim();
    const period = String(body?.period || "day");
    if (!code) throw new Error("缺少股票代码");
    const cacheKey = `${code}:${period}`;
    const cached = getStockCache(cacheKey);
    if (cached) return json(res, 200, cached);
    const data = await fetchAndParseData(code, period);
    setStockCache(cacheKey, data);
    return json(res, 200, data);
  }

  if (p === "/api/stock/timeline" && req.method === "POST") {
    const body = await readJsonBody(req);
    const code = String(body?.code || "").trim();
    const period = String(body?.period || "day");
    if (!code) throw new Error("缺少股票代码");
    const cacheKey = `${code}:${period}`;
    const cached = getStockCache(cacheKey);
    if (cached?.kline?.length) return json(res, 200, cached.kline);
    const data = await fetchAndParseData(code, period);
    setStockCache(cacheKey, data);
    return json(res, 200, data.kline || []);
  }

  if (p === "/api/stock/search" && req.method === "POST") {
    const body = await readJsonBody(req);
    return json(res, 200, await searchStocks(String(body?.keyword || "")));
  }

  if (p === "/api/ai/analyze" && req.method === "POST") {
    const body = await readJsonBody(req);
    const code = String(body?.code || "").trim();
    const requestedName = String(body?.name || "").trim();
    const analysisType = String(body?.analysisType || "f10");
    if (!code) throw new Error("缺少股票代码");
    if (!["f10", "orderbook"].includes(analysisType)) throw new Error("分析类型不支持");

    const settings = getSettings(true);
    const profiles = Array.isArray(settings.ai_profiles) ? settings.ai_profiles : [];
    const active = profiles.find((x) => x.id === settings.active_ai_profile_id) || profiles[0] || {
      base_url: settings.ai_base_url,
      api_key: settings.ai_api_key,
      model: settings.ai_model,
    };
    if (!active.base_url || !active.api_key || !active.model) {
      throw new Error("请先在 AI 设置中配置并选择可用模型");
    }

    const quote = await fetchAndParseData(code, "day");
    const today = nowDate();
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
      systemPrompt = `你是耐心、负责的A股交易讲解员。日期：${today}。\n请用“新手也能看懂”的中文解释盘面，不要堆砌术语，不要使用生硬或居高临下的表达。\n要求：\n1) 先说结论，再说理由；\n2) 每段2-3句话，句子短一些；\n3) 必须解释术语（如金叉、死叉、放量、缩量）是什么意思；\n4) 给出风险提醒，不得给出“保证上涨/下跌”的绝对判断；\n5) 输出纯文本，不用Markdown表格。`;
      userPrompt = `请分析这只股票的“盘口情况”，并用通俗语言输出：\n\n股票: ${quote.name}(${code})\n现价: ${quote.price}\n涨跌幅: ${changePercent}%\n买盘总手: ${buyTotal}\n卖盘总手: ${sellTotal}\n今日主力资金净额: ${quote.mainNetInflow}\n\n技术形态: ${tdxText}\n资金变化: ${mfText}\n\n请严格按这个结构输出（标题可微调，但顺序不要变）：\n1. 一句话结论（偏强/震荡/偏弱）\n2. 现在盘面在发生什么（买卖盘、量价关系，用白话解释）\n3. 技术指标怎么看（MA、MACD、GMMA分别代表什么，现在是偏多还是偏空）\n4. 资金面怎么看（主力净流入/流出代表什么）\n5. 新手操作提醒（分3条：可做什么、不要做什么、什么信号出现再行动）\n6. 风险提示（至少2条）\n\n注意：\n- 不要只给结论，必须告诉“为什么”；\n- 避免“建议重仓、梭哈”这类激进措辞；\n- 语言尽量口语化、易懂。`;
    }

    const resp = await fetch(`${String(active.base_url).replace(/\/$/, "")}/chat/completions`, {
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
    if (!resp.ok) {
      throw new Error(`AI 分析失败: ${resp.status} ${await resp.text()}`);
    }
    const out = await resp.json();
    const content = out?.choices?.[0]?.message?.content || "";
    const normalizedName = await normalizeReportName(code, requestedName || quote.name);
    const result = {
      code,
      name: normalizedName,
      price: quote.price,
      analysis: Array.isArray(content) ? content.map((c) => c?.text || "").join("\n") : String(content),
      analysis_type: analysisType,
    };
    saveAiReport({ code: result.code, name: result.name, analysis_type: analysisType, content: result.analysis });
    return json(res, 200, result);
  }

  if (p === "/api/backup/export-json" && req.method === "GET") {
    return json(res, 200, { ok: true, canceled: false, data: exportBackupData() });
  }
  if (p === "/api/backup/import-json" && req.method === "POST") {
    const body = await readJsonBody(req);
    const mode = String(body?.mode || "merge").toLowerCase() === "replace" ? "replace" : "merge";
    const overwriteSecrets = Boolean(body?.overwriteSecrets);
    const backup = body?.data;
    if (!backup || typeof backup !== "object") throw new Error("缺少备份数据 data");
    const result = importBackupData({ ...backup, mode, overwriteSecrets });
    return json(res, 200, { ...result, canceled: false });
  }

  return notFound(res);
}

async function start() {
  fs.mkdirSync(APP_DATA_DIR, { recursive: true });
  initDb(DB_PATH);

  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method || "GET";
      const urlObj = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (urlObj.pathname.startsWith("/api/")) {
        await handleApi(req, res, urlObj);
        return;
      }
      if (method === "GET") {
        await serveStatic(urlObj.pathname, res);
        return;
      }
      notFound(res);
    } catch (e) {
      if (e && typeof e === "object" && "statusCode" in e) {
        const statusCode = Number(e.statusCode) || 500;
        json(res, statusCode, { error: e instanceof Error ? e.message : String(e) });
        return;
      }
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`[stocktradehistory] server running on http://${HOST}:${PORT}`);
    console.log(`[stocktradehistory] sqlite: ${DB_PATH}`);
  });
}

start().catch((e) => {
  console.error(e);
  process.exit(1);
});
