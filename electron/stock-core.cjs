const DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/5.0",
};
const iconv = require("iconv-lite");
const REQUEST_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function decodeChineseText(s) {
  const text = String(s || "");
  if (!text) return text;
  if (/^[\x00-\x7F]*$/.test(text)) return text;
  if (/[\u4e00-\u9fff]/.test(text)) return text;
  try {
    const decoded = iconv.decode(Buffer.from(text, "latin1"), "gbk");
    if (decoded && /[\u4e00-\u9fff]/.test(decoded)) return decoded;
    return text;
  } catch (_e) {
    return text;
  }
}

function toMarketSymbol(code) {
  const c = String(code || "").trim();
  if (!c) return "";
  if (c.startsWith("6") || c.startsWith("9")) return `sh${c}`;
  return `sz${c}`;
}

function parseTencentQuote(text, code) {
  const idx = text.indexOf('="');
  if (idx < 0) return null;
  const body = text.slice(idx + 2).replace(/";?\s*$/, "");
  const parts = body.split("~");
  if (parts.length < 50) return null;
  const name = decodeChineseText(parts[1] || code);
  const price = Number(parts[3] || 0);
  const prevClose = Number(parts[4] || 0);
  const open = Number(parts[5] || 0);
  const high = Number(parts[33] || 0);
  const low = Number(parts[34] || 0);
  const volumeHands = Number(parts[36] || 0);
  const turnover = Number(parts[38] || 0);
  const bidAsk = [];
  for (let i = 0; i < 5; i += 1) {
    const bidPrice = Number(parts[9 + i * 2] || 0);
    const bidVol = Number(parts[10 + i * 2] || 0);
    const askPrice = Number(parts[19 + i * 2] || 0);
    const askVol = Number(parts[20 + i * 2] || 0);
    bidAsk.push({ level: i + 1, bidPrice, bidVol, askPrice, askVol });
  }
  return { name, price, prevClose, open, high, low, volumeHands, turnover, bidAsk };
}

function parseSinaQuote(text, code) {
  const idx = text.indexOf('="');
  if (idx < 0) return null;
  const body = text.slice(idx + 2).replace(/";?\s*$/, "");
  const p = body.split(",");
  if (p.length < 32) return null;
  const name = decodeChineseText(p[0] || code);
  const open = Number(p[1] || 0);
  const prevClose = Number(p[2] || 0);
  const price = Number(p[3] || 0);
  const high = Number(p[4] || 0);
  const low = Number(p[5] || 0);
  const volumeHands = Number(p[8] || 0) / 100;
  const turnover = Number(p[9] || 0);
  const bidAsk = [];
  for (let i = 0; i < 5; i += 1) {
    const bidVol = Number(p[10 + i * 2] || 0) / 100;
    const bidPrice = Number(p[11 + i * 2] || 0);
    const askVol = Number(p[20 + i * 2] || 0) / 100;
    const askPrice = Number(p[21 + i * 2] || 0);
    bidAsk.push({ level: i + 1, bidPrice, bidVol, askPrice, askVol });
  }
  return { name, price, prevClose, open, high, low, volumeHands, turnover, bidAsk };
}

async function fetchQuote(code) {
  const m = toMarketSymbol(code);
  const tencentUrl = `https://qt.gtimg.cn/q=${m}`;
  try {
    const res = await fetchWithTimeout(tencentUrl, { headers: DEFAULT_HEADERS });
    const txt = await res.text();
    const q = parseTencentQuote(txt, code);
    if (q) return q;
  } catch (_e) {}

  const sinaUrl = `https://hq.sinajs.cn/list=${m}`;
  const res = await fetchWithTimeout(sinaUrl, { headers: DEFAULT_HEADERS });
  const txt = await res.text();
  const q = parseSinaQuote(txt, code);
  if (!q) throw new Error(`行情解析失败: ${code}`);
  return q;
}

async function fetchMainNetInflow(code) {
  const secid = code.startsWith("6") ? `1.${code}` : `0.${code}`;
  const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f12,f62&secids=${secid}`;
  try {
    const res = await fetchWithTimeout(url, { headers: DEFAULT_HEADERS });
    const json = await res.json();
    const item = json?.data?.diff?.[0];
    return Number(item?.f62 || 0);
  } catch (_e) {
    return 0;
  }
}

async function fetchKline(code, period = "day") {
  const m = toMarketSymbol(code);
  if (period === "timeline") {
    const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${m}`;
    const res = await fetchWithTimeout(url, { headers: DEFAULT_HEADERS });
    const json = await res.json();
    const data = json?.data?.[m]?.data?.data || [];
    return data.map((line) => {
      const p = String(line).split(" ");
      return {
        date: p[0] || "",
        open: Number(p[1] || 0),
        close: Number(p[1] || 0),
        high: Number(p[1] || 0),
        low: Number(p[1] || 0),
        volume: Number(p[2] || 0),
      };
    });
  }

  const kType = period === "week" ? "week" : "day";
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${m},${kType},,,120,qfq`;
  const res = await fetchWithTimeout(url, { headers: DEFAULT_HEADERS });
  const json = await res.json();
  const node = json?.data?.[m];
  const arr = period === "week" ? (node?.qfqweek || node?.week || []) : (node?.qfqday || node?.day || []);
  return arr.map((d) => ({
    date: d[0],
    open: Number(d[1]),
    close: Number(d[2]),
    high: Number(d[3]),
    low: Number(d[4]),
    volume: Number(d[5] || 0),
  }));
}

async function fetchAndParseData(code, period = "day") {
  const [quote, inflow, kline] = await Promise.all([
    fetchQuote(code),
    fetchMainNetInflow(code),
    fetchKline(code, period),
  ]);
  return {
    code,
    ...quote,
    mainNetInflow: inflow,
    kline,
  };
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function searchStocks(keyword) {
  const q = String(keyword || "").trim();
  if (!q) return [];
  const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(q)}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8`;
  const res = await fetchWithTimeout(url, { headers: DEFAULT_HEADERS });
  const json = await res.json();
  const list = json?.QuotationCodeTable?.Data || [];
  return list
    .filter((x) => x?.Code && /^\d{6}$/.test(String(x.Code)))
    .slice(0, 20)
    .map((x) => ({ code: String(x.Code), name: String(x.Name || x.ShortName || x.Code), market: String(x.SecurityTypeName || "") }));
}

async function fetchF10Bundle(code) {
  const pureCode = String(code || "").trim();
  const secCode = pureCode.startsWith("6") ? `SH${pureCode}` : `SZ${pureCode}`;

  let companySurvey = "";
  let financeAnalysis = "";
  let thsText = "";
  const sinaTexts = [];

  try {
    const url = `https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/CompanySurveyAjax?code=${secCode}`;
    const res = await fetchWithTimeout(url, { headers: DEFAULT_HEADERS });
    companySurvey = JSON.stringify(await res.json()).slice(0, 3000);
  } catch (_e) {}

  try {
    const url = `https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/ZYZBAjaxNew?type=0&code=${secCode}`;
    const res = await fetchWithTimeout(url, { headers: DEFAULT_HEADERS });
    financeAnalysis = JSON.stringify(await res.json()).slice(0, 3000);
  } catch (_e) {}

  try {
    const url = `https://basic.10jqka.com.cn/${pureCode}/`;
    const res = await fetchWithTimeout(url, { headers: DEFAULT_HEADERS });
    thsText = stripHtml(await res.text()).slice(0, 6000);
  } catch (_e) {}

  const sinaF10Paths = [
    `https://vip.stock.finance.sina.com.cn/corp/go.php/vCI_CorpInfo/stockid/${pureCode}.phtml`,
    `https://vip.stock.finance.sina.com.cn/corp/go.php/vCI_StockStructure/stockid/${pureCode}.phtml`,
    `https://vip.stock.finance.sina.com.cn/corp/go.php/vCI_StockHolder/stockid/${pureCode}.phtml`,
    `https://vip.stock.finance.sina.com.cn/corp/go.php/vFD_FinanceSummary/stockid/${pureCode}.phtml`,
    `https://vip.stock.finance.sina.com.cn/corp/go.php/vCB_Bulletin/stockid/${pureCode}.phtml`,
  ];
  for (const url of sinaF10Paths) {
    try {
      const res = await fetchWithTimeout(url, { headers: DEFAULT_HEADERS });
      const txt = stripHtml(await res.text()).slice(0, 2000);
      sinaTexts.push(`[${url}] ${txt}`);
    } catch (_e) {}
  }

  return {
    companySurvey,
    financeAnalysis,
    thsText,
    sinaText: sinaTexts.join("\n"),
  };
}

async function getMoneyFlowHistory(code) {
  const secid = code.startsWith("6") ? `1.${code}` : `0.${code}`;
  const url = `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?lmt=30&klt=101&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63&secid=${secid}`;
  try {
    const res = await fetchWithTimeout(url, { headers: DEFAULT_HEADERS });
    const json = await res.json();
    const klines = json?.data?.klines || [];
    return klines.map((line) => {
      const p = String(line).split(",");
      return { date: p[0], mainNet: Number(p[1] || 0) };
    });
  } catch (_e) {
    return [];
  }
}

function extractTdxFeatures(kline) {
  if (!Array.isArray(kline) || kline.length < 30) return "K线样本不足，无法稳定计算MA/MACD/GMMA。";
  const closes = kline.map((k) => Number(k.close || 0));
  const ma = (arr, n, i) => arr.slice(Math.max(0, i - n + 1), i + 1).reduce((a, b) => a + b, 0) / Math.min(n, i + 1);
  const last = closes.length - 1;
  const ma5 = ma(closes, 5, last);
  const ma10 = ma(closes, 10, last);
  const ma20 = ma(closes, 20, last);
  const ma5Prev = ma(closes, 5, last - 1);
  const ma10Prev = ma(closes, 10, last - 1);
  const maCross = ma5Prev <= ma10Prev && ma5 > ma10 ? "MA5上穿MA10(金叉)" : ma5Prev >= ma10Prev && ma5 < ma10 ? "MA5下穿MA10(死叉)" : "MA5与MA10无新交叉";

  const ema = (vals, n) => {
    const k = 2 / (n + 1);
    const out = [vals[0]];
    for (let i = 1; i < vals.length; i += 1) out.push(vals[i] * k + out[i - 1] * (1 - k));
    return out;
  };
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const dif = closes.map((_, i) => ema12[i] - ema26[i]);
  const dea = ema(dif, 9);
  const macdCross = dif[last - 1] <= dea[last - 1] && dif[last] > dea[last] ? "MACD金叉" : dif[last - 1] >= dea[last - 1] && dif[last] < dea[last] ? "MACD死叉" : "MACD无新交叉";

  const gmmaShort = [3, 5, 8, 10, 12, 15].map((n) => ma(closes, n, last));
  const gmmaLong = [30, 35, 40, 45, 50, 60].map((n) => ma(closes, n, last));
  const shortAvg = gmmaShort.reduce((a, b) => a + b, 0) / gmmaShort.length;
  const longAvg = gmmaLong.reduce((a, b) => a + b, 0) / gmmaLong.length;
  const gmmaState = shortAvg > longAvg ? "GMMA短组在长组上方(偏多)" : "GMMA短组在长组下方(偏空)";

  return `MA5=${ma5.toFixed(2)}, MA10=${ma10.toFixed(2)}, MA20=${ma20.toFixed(2)}; ${maCross}; ${macdCross}; ${gmmaState}`;
}

module.exports = {
  fetchAndParseData,
  searchStocks,
  fetchF10Bundle,
  getMoneyFlowHistory,
  extractTdxFeatures,
};
