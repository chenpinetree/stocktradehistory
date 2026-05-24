const XLSX = require("xlsx");
const iconv = require("iconv-lite");
const Database = require("better-sqlite3");
const path = require("node:path");
const os = require("node:os");

function decode(s) {
  return iconv.decode(Buffer.from(String(s), "latin1"), "gbk");
}

function side(v) {
  const s = decode(v);
  if (s.includes("买入")) return "BUY";
  return "SELL";
}

function toDate8(v) {
  const s = String(v);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function to24h(t12) {
  if (!/(AM|PM)$/.test(t12)) return t12;
  const m = t12.match(/^(\d\d):(\d\d):(\d\d) (AM|PM)$/);
  let hh = Number(m[1]);
  const mm = m[2];
  const ss = m[3];
  const ap = m[4];
  if (ap === "AM" && hh === 12) hh = 0;
  if (ap === "PM" && hh !== 12) hh += 12;
  return `${String(hh).padStart(2, "0")}:${mm}:${ss}`;
}

const db = new Database(path.join(os.homedir(), "Library", "Application Support", "stock-trade-local-app", "trade-history.db"));
const wb = XLSX.readFile("/Users/chen/Downloads/stocktradehistory/20260507历史成交查询.xls");
const ws = wb.Sheets[wb.SheetNames[0]];
const excelRows = XLSX.utils.sheet_to_json(ws, { defval: "" });

const excelMap = new Map();
for (const r of excelRows) {
  const key = `${toDate8(r["³É½»ÈÕÆÚ"])}|${String(r["³É½»Ê±¼ä"]).trim()}|${String(r["Ö¤È¯´úÂë"]).trim()}|${side(r["ÂòÂô±êÖ¾"])}|${Number(r["³É½»¼Û¸ñ"]).toFixed(4)}|${Number(r["³É½»ÊýÁ¿"])}`;
  excelMap.set(key, Number(r["³É½»½ð¶î"]));
}

const dbRows = db.prepare("SELECT id, trade_date, trade_time, symbol, side, price, quantity, amount FROM trades").all();
const mismatches = [];
let matched = 0;
for (const r of dbRows) {
  const key = `${r.trade_date}|${to24h(r.trade_time)}|${r.symbol}|${r.side}|${Number(r.price).toFixed(4)}|${Number(r.quantity)}`;
  if (!excelMap.has(key)) continue;
  matched += 1;
  const excelAmount = excelMap.get(key);
  if (Math.abs(Number(r.amount) - Number(excelAmount)) > 0.001) {
    mismatches.push({ id: r.id, key, dbAmount: r.amount, excelAmount });
  }
}

console.log(`excel rows=${excelRows.length}, db rows=${dbRows.length}, matched=${matched}, amount mismatches=${mismatches.length}`);
if (mismatches.length) {
  console.log(mismatches.slice(0, 20));
}
