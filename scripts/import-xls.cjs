const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const XLSX = require("xlsx");
const iconv = require("iconv-lite");
const { initDb, listTrades, createTrade } = require("../electron/services.cjs");

function decode(s) {
  if (typeof s !== "string") return s;
  return iconv.decode(Buffer.from(s, "latin1"), "gbk");
}

function toDate(v) {
  const s = String(v).trim();
  if (!/^\d{8}$/.test(s)) throw new Error(`非法日期: ${s}`);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function toTime24(v) {
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!m) throw new Error(`非法时间: ${s}`);
  const hh = Number(m[1]);
  const mm = m[2];
  const ss = m[3];
  return `${String(hh).padStart(2, "0")}:${mm}:${ss}`;
}

function toSide(v) {
  const s = decode(String(v));
  if (s.includes("买入")) return "BUY";
  if (s.includes("卖出")) return "SELL";
  throw new Error(`无法识别买卖标志: ${s}`);
}

function main() {
  const sourcePath = process.argv[2];
  if (!sourcePath) {
    throw new Error("用法: node scripts/import-xls.cjs <xls文件路径>");
  }

  const userDataDir = path.join(os.homedir(), "Library", "Application Support", "stock-trade-local-app");
  fs.mkdirSync(userDataDir, { recursive: true });
  const dbPath = path.join(userDataDir, "trade-history.db");
  initDb(dbPath);

  const wb = XLSX.readFile(sourcePath, { cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

  const existing = listTrades();
  const exists = new Set(
    existing.map((t) => `${t.trade_date}|${t.trade_time}|${t.symbol}|${t.side}|${Number(t.price).toFixed(4)}|${t.quantity}`)
  );

  let imported = 0;
  let skipped = 0;

  for (const r of rows) {
    const tradeDateRaw = r["³É½»ÈÕÆÚ"];
    const tradeTimeRaw = r["³É½»Ê±¼ä"];
    const symbol = String(r["Ö¤È¯´úÂë"] || "").trim();
    const securityName = decode(String(r["Ö¤È¯Ãû³Æ"] || "")).trim();
    const side = toSide(r["ÂòÂô±êÖ¾"]);
    const price = Number(r["³É½»¼Û¸ñ"]);
    const quantity = Number(r["³É½»ÊýÁ¿"]);

    if (!tradeDateRaw || !tradeTimeRaw || !symbol || !securityName || !Number.isFinite(price) || !Number.isFinite(quantity)) {
      skipped += 1;
      continue;
    }

    const trade_date = toDate(tradeDateRaw);
    const trade_time = toTime24(tradeTimeRaw);
    const key = `${trade_date}|${trade_time}|${symbol}|${side}|${price.toFixed(4)}|${quantity}`;
    if (exists.has(key)) {
      skipped += 1;
      continue;
    }

    createTrade({
      trade_date,
      trade_time,
      symbol,
      security_name: securityName,
      side,
      price,
      quantity,
      source: "MANUAL",
    });
    exists.add(key);
    imported += 1;
  }

  console.log(`导入完成: 新增 ${imported} 条, 跳过 ${skipped} 条`);
}

main();
