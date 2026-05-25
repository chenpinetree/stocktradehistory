const Database = require("better-sqlite3");
const XLSX = require("xlsx");
const iconv = require("iconv-lite");
const crypto = require("node:crypto");

let db;
const CLEAR_ALL_TRADES_CONFIRM_TEXT = "我确定清除所有交易记录";

function initDb(dbPath) {
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      initial_capital REAL NOT NULL DEFAULT 0,
      ai_base_url TEXT,
      ai_api_key TEXT,
      ai_model TEXT,
      ai_profiles_json TEXT,
      active_ai_profile_id TEXT,
      app_lock_enabled INTEGER NOT NULL DEFAULT 0,
      app_password_hash TEXT,
      app_password_salt TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_date TEXT NOT NULL,
      trade_time TEXT NOT NULL,
      symbol TEXT NOT NULL,
      security_name TEXT NOT NULL,
      trade_no TEXT,
      side TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
      price REAL NOT NULL,
      quantity INTEGER NOT NULL,
      amount REAL NOT NULL,
      fee REAL NOT NULL DEFAULT 5.0,
      source TEXT NOT NULL CHECK(source IN ('MANUAL','AI')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sell_matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sell_trade_id INTEGER NOT NULL,
      buy_trade_id INTEGER NOT NULL,
      matched_qty INTEGER NOT NULL,
      buy_price REAL NOT NULL,
      sell_price REAL NOT NULL,
      gross_profit REAL NOT NULL,
      allocated_fee REAL NOT NULL,
      net_profit REAL NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      name TEXT,
      analysis_type TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  try {
    db.prepare("ALTER TABLE app_settings ADD COLUMN ai_profiles_json TEXT").run();
  } catch (_e) {}
  try {
    db.prepare("ALTER TABLE app_settings ADD COLUMN active_ai_profile_id TEXT").run();
  } catch (_e) {}
  try {
    db.prepare("ALTER TABLE app_settings ADD COLUMN app_lock_enabled INTEGER NOT NULL DEFAULT 0").run();
  } catch (_e) {}
  try {
    db.prepare("ALTER TABLE app_settings ADD COLUMN app_password_hash TEXT").run();
  } catch (_e) {}
  try {
    db.prepare("ALTER TABLE app_settings ADD COLUMN app_password_salt TEXT").run();
  } catch (_e) {}
  try {
    db.prepare("ALTER TABLE trades ADD COLUMN trade_no TEXT").run();
  } catch (_e) {}
  try {
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_trade_no_unique ON trades(trade_no) WHERE trade_no IS NOT NULL AND trade_no <> ''").run();
  } catch (_e) {}

  const existing = db.prepare("SELECT id FROM app_settings WHERE id = 1").get();
  if (!existing) {
    db.prepare(
      "INSERT INTO app_settings (id, initial_capital, ai_base_url, ai_api_key, ai_model, ai_profiles_json, active_ai_profile_id, updated_at) VALUES (1, 0, '', '', '', '[]', '', ?)"
    ).run(now());
  }

  normalizeTradeTimeTo24h();
  normalizeAmountsTo2Decimals();
  normalizeFeesByRules();
  rebuildSellMatches();
  normalizeSellMatchFees();
}

function scryptHash(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 64).toString("hex");
}

function hasAppPassword() {
  const row = db.prepare("SELECT app_lock_enabled, app_password_hash, app_password_salt FROM app_settings WHERE id = 1").get();
  return Boolean(row && Number(row.app_lock_enabled) === 1 && row.app_password_hash && row.app_password_salt);
}

function setupAppPassword(password) {
  const pwd = String(password || "");
  if (pwd.length < 6) throw new Error("密码至少 6 位");
  if (hasAppPassword()) throw new Error("主密码已设置");
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = scryptHash(pwd, salt);
  db.prepare("UPDATE app_settings SET app_lock_enabled = 1, app_password_hash = ?, app_password_salt = ?, updated_at = ? WHERE id = 1").run(hash, salt, now());
  return { ok: true };
}

function verifyAppPassword(password) {
  const row = db.prepare("SELECT app_lock_enabled, app_password_hash, app_password_salt FROM app_settings WHERE id = 1").get();
  if (!row || Number(row.app_lock_enabled) !== 1 || !row.app_password_hash || !row.app_password_salt) {
    throw new Error("主密码未设置");
  }
  const incoming = scryptHash(String(password || ""), row.app_password_salt);
  const expected = String(row.app_password_hash);
  const incomingBuf = Buffer.from(incoming, "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  if (incomingBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(incomingBuf, expectedBuf)) {
    return false;
  }
  return true;
}

function changeAppPassword(oldPassword, newPassword) {
  if (!verifyAppPassword(oldPassword)) {
    throw new Error("旧密码错误");
  }
  const pwd = String(newPassword || "");
  if (!pwd) {
    return clearAppPasswordLock();
  }
  if (pwd.length < 6) throw new Error("新密码至少 6 位");
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = scryptHash(pwd, salt);
  db.prepare("UPDATE app_settings SET app_password_hash = ?, app_password_salt = ?, updated_at = ? WHERE id = 1").run(hash, salt, now());
  return { ok: true };
}

function clearAppPasswordLock() {
  db.prepare("UPDATE app_settings SET app_lock_enabled = 0, app_password_hash = NULL, app_password_salt = NULL, updated_at = ? WHERE id = 1").run(now());
  return { ok: true };
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function calcFee(side, amount) {
  const baseFee = 5;
  const stampTax = side === "SELL" ? round2(Number(amount) * 0.0005) : 0;
  return round2(baseFee + stampTax);
}

function now() {
  return new Date().toISOString();
}

function todayDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function validateTrade(input) {
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(input.trade_date);
  const timeOk = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(input.trade_time);
  if (!dateOk) throw new Error("日期格式错误，必须是 YYYY-MM-DD");
  if (!timeOk) throw new Error("时间格式错误，必须是 HH:mm:ss（24小时制）");
  if (!["BUY", "SELL"].includes(input.side)) throw new Error("买卖标志必须是 BUY 或 SELL");
  const p = Number(input.price);
  const q = Number(input.quantity);
  if (!Number.isFinite(p) || p <= 0) throw new Error("成交价格必须大于 0");
  if (!Number.isFinite(q) || !Number.isInteger(q) || q <= 0) throw new Error("成交数量必须是正整数");
}

function to24h(timeText) {
  const s = String(timeText || "").trim();
  const m = s.match(/^(\d\d):(\d\d):(\d\d) (AM|PM)$/);
  if (!m) return s;
  let hh = Number(m[1]);
  const mm = m[2];
  const ss = m[3];
  const ap = m[4];
  if (ap === "AM" && hh === 12) hh = 0;
  if (ap === "PM" && hh !== 12) hh += 12;
  return `${String(hh).padStart(2, "0")}:${mm}:${ss}`;
}

function normalizeTradeInput(input) {
  return {
    ...input,
    trade_date: String(input?.trade_date || "").trim(),
    trade_time: to24h(String(input?.trade_time || "").trim()),
    symbol: String(input?.symbol || "").trim(),
    security_name: String(input?.security_name || "").trim(),
    trade_no: String(input?.trade_no || "").trim(),
    side: String(input?.side || "").trim(),
    source: String(input?.source || "MANUAL").trim() || "MANUAL",
  };
}

function findTradeByTradeNo(tradeNo) {
  const no = String(tradeNo || "").trim();
  if (!no) return null;
  return db.prepare("SELECT id FROM trades WHERE trade_no = ? LIMIT 1").get(no) || null;
}

function mapSideFromText(sideText) {
  const s = decodeMaybeMojibake(String(sideText || "")).trim();
  const buyTokens = new Set(["BUY", "买", "买入", "证券买入", "B"]);
  const sellTokens = new Set(["SELL", "卖", "卖出", "证券卖出", "S"]);
  if (buyTokens.has(s)) return "BUY";
  if (sellTokens.has(s)) return "SELL";
  throw new Error(`买卖标志不支持: ${s || "(空)"}`);
}

function normalizeTradeTimeTo24h() {
  const rows = db.prepare("SELECT id, trade_time FROM trades WHERE trade_time LIKE '% AM' OR trade_time LIKE '% PM'").all();
  const stmt = db.prepare("UPDATE trades SET trade_time = ? WHERE id = ?");
  const trx = db.transaction(() => {
    for (const r of rows) {
      stmt.run(to24h(r.trade_time), r.id);
    }
  });
  trx();
}

function normalizeAmountsTo2Decimals() {
  const rows = db.prepare("SELECT id, price, quantity FROM trades").all();
  const stmt = db.prepare("UPDATE trades SET amount = ? WHERE id = ?");
  const trx = db.transaction(() => {
    for (const r of rows) {
      stmt.run(round2(Number(r.price) * Number(r.quantity)), r.id);
    }
  });
  trx();
}

function normalizeFeesByRules() {
  const rows = db.prepare("SELECT id, side, amount FROM trades").all();
  const stmt = db.prepare("UPDATE trades SET fee = ? WHERE id = ?");
  const trx = db.transaction(() => {
    for (const r of rows) {
      stmt.run(calcFee(r.side, r.amount), r.id);
    }
  });
  trx();
}

function normalizeSellMatchFees() {
  const rows = db
    .prepare(
      `SELECT sm.id, sm.gross_profit, sm.matched_qty,
              b.fee AS buy_fee, b.quantity AS buy_qty,
              s.fee AS sell_fee, s.quantity AS sell_qty
       FROM sell_matches sm
       JOIN trades b ON b.id = sm.buy_trade_id
       JOIN trades s ON s.id = sm.sell_trade_id`
    )
    .all();
  const stmt = db.prepare("UPDATE sell_matches SET allocated_fee = ?, net_profit = ? WHERE id = ?");
  const trx = db.transaction(() => {
    for (const r of rows) {
      const buyPart = Number(r.buy_qty) > 0 ? (Number(r.buy_fee) * Number(r.matched_qty)) / Number(r.buy_qty) : 0;
      const sellPart = Number(r.sell_qty) > 0 ? (Number(r.sell_fee) * Number(r.matched_qty)) / Number(r.sell_qty) : 0;
      const allocated = round2(buyPart + sellPart);
      const net = round2(Number(r.gross_profit) - allocated);
      stmt.run(allocated, net, r.id);
    }
  });
  trx();
}

function saveSettings(input) {
  const prev = getSettings(true);
  const prevProfiles = Array.isArray(prev.ai_profiles) ? prev.ai_profiles : [];
  const prevProfileMap = new Map(prevProfiles.map((p) => [String(p.id || ""), p]));

  const profilesInput = Array.isArray(input.ai_profiles) ? input.ai_profiles : [];
  const profiles = profilesInput.map((p) => {
    const id = String(p?.id || "");
    const old = prevProfileMap.get(id);
    const nextKey = String(p?.api_key || "").trim();
    return {
      ...p,
      api_key: nextKey || String(old?.api_key || ""),
    };
  });

  const activeId = input.active_ai_profile_id || "";
  const rootApiKey = String(input.ai_api_key || "").trim() || String(prev.ai_api_key || "");

  db.prepare(
    `UPDATE app_settings
     SET initial_capital = ?, ai_base_url = ?, ai_api_key = ?, ai_model = ?, ai_profiles_json = ?, active_ai_profile_id = ?, updated_at = ?
     WHERE id = 1`
  ).run(
    Number(input.initial_capital || 0),
    input.ai_base_url || "",
    rootApiKey,
    input.ai_model || "",
    JSON.stringify(profiles),
    activeId,
    now()
  );
  return getSettings();
}

function getSettings(includeSecrets = false) {
  const row = db.prepare("SELECT * FROM app_settings WHERE id = 1").get();
  let ai_profiles = [];
  try {
    ai_profiles = JSON.parse(row.ai_profiles_json || "[]");
  } catch (_e) {
    ai_profiles = [];
  }

  const out = {
    ...row,
    ai_profiles,
    active_ai_profile_id: row.active_ai_profile_id || "",
    app_lock_enabled: Number(row.app_lock_enabled || 0),
  };

  if (!includeSecrets) {
    out.ai_api_key = "";
    out.ai_profiles = ai_profiles.map((p) => ({ ...p, api_key: "" }));
  }
  delete out.app_password_hash;
  delete out.app_password_salt;
  return out;
}

function resolveActiveProfile(settings) {
  const profiles = Array.isArray(settings.ai_profiles) ? settings.ai_profiles : [];
  if (profiles.length > 0) {
    const active = profiles.find((p) => p.id === settings.active_ai_profile_id) || profiles[0];
    return {
      base_url: active.base_url,
      api_key: active.api_key,
      model: active.model,
    };
  }

  return {
    base_url: settings.ai_base_url,
    api_key: settings.ai_api_key,
    model: settings.ai_model,
  };
}

function getRemainingQtyByBuyTradeId(buyTradeId) {
  const buy = db.prepare("SELECT quantity FROM trades WHERE id = ?").get(buyTradeId);
  const matched = db.prepare("SELECT COALESCE(SUM(matched_qty), 0) AS m FROM sell_matches WHERE buy_trade_id = ?").get(buyTradeId);
  return buy.quantity - matched.m;
}

function rebuildSellMatches() {
  const trades = db
    .prepare("SELECT * FROM trades ORDER BY trade_date ASC, trade_time ASC, id ASC")
    .all();

  const clearStmt = db.prepare("DELETE FROM sell_matches");
  const insertStmt = db.prepare(
    `INSERT INTO sell_matches
     (sell_trade_id, buy_trade_id, matched_qty, buy_price, sell_price, gross_profit, allocated_fee, net_profit, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const buyPools = new Map();

  const trx = db.transaction(() => {
    clearStmt.run();

    for (const t of trades) {
      if (t.side === "BUY") {
        const arr = buyPools.get(t.symbol) || [];
        arr.push({ id: t.id, price: Number(t.price), quantity: Number(t.quantity), fee: Number(t.fee), remaining: Number(t.quantity), trade_date: t.trade_date, trade_time: t.trade_time });
        buyPools.set(t.symbol, arr);
        continue;
      }

      if (t.side !== "SELL") continue;

      const arr = buyPools.get(t.symbol) || [];
      arr.sort((a, b) => {
        if (a.price !== b.price) return a.price - b.price;
        if (a.trade_date !== b.trade_date) return a.trade_date < b.trade_date ? -1 : 1;
        if (a.trade_time !== b.trade_time) return a.trade_time < b.trade_time ? -1 : 1;
        return a.id - b.id;
      });

      let remainingSellQty = Number(t.quantity);
      for (const b of arr) {
        if (remainingSellQty <= 0) break;
        if (b.remaining <= 0) continue;

        const matchedQty = Math.min(b.remaining, remainingSellQty);
        const gross = round2((Number(t.price) - b.price) * matchedQty);
        const buyFeePart = (b.fee * matchedQty) / b.quantity;
        const sellFeePart = (Number(t.fee) * matchedQty) / Number(t.quantity);
        const allocatedFee = round2(buyFeePart + sellFeePart);
        const net = round2(gross - allocatedFee);

        insertStmt.run(t.id, b.id, matchedQty, b.price, Number(t.price), gross, allocatedFee, net, now());
        b.remaining -= matchedQty;
        remainingSellQty -= matchedQty;
      }

      if (remainingSellQty > 0) {
        throw new Error("可卖数量不足，无法完成卖出");
      }
    }
  });

  trx();
}

function createTrade(input) {
  const normalized = normalizeTradeInput(input);
  validateTrade(normalized);
  if (normalized.trade_no && findTradeByTradeNo(normalized.trade_no)) {
    return { ok: true, skipped: true, reason: "duplicate_trade_no" };
  }
  const payload = {
    ...normalized,
    fee: 0,
    amount: round2(Number(normalized.price) * Number(normalized.quantity)),
  };
  payload.fee = calcFee(payload.side, payload.amount);

  const trx = db.transaction(() => {
    db
      .prepare(
        `INSERT INTO trades
         (trade_date, trade_time, symbol, security_name, trade_no, side, price, quantity, amount, fee, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        payload.trade_date,
        payload.trade_time,
        payload.symbol,
        payload.security_name,
        payload.trade_no || null,
        payload.side,
        payload.price,
        payload.quantity,
        payload.amount,
        payload.fee,
        payload.source,
        now()
      );

    rebuildSellMatches();
  });

  trx();
  return { ok: true };
}

function createTradesBulk(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("批量导入数据不能为空");
  }

  const normalizedRows = rows.map((row) => {
    const normalized = normalizeTradeInput(row);
    validateTrade(normalized);
    const amount = round2(Number(normalized.price) * Number(normalized.quantity));
    const fee = calcFee(normalized.side, amount);
    return {
      ...normalized,
      amount,
      fee,
    };
  });

  const seen = new Set();
  const dedupedRows = [];
  let skipped = 0;
  for (const row of normalizedRows) {
    const no = String(row.trade_no || "").trim();
    if (no) {
      if (seen.has(no) || findTradeByTradeNo(no)) {
        skipped += 1;
        continue;
      }
      seen.add(no);
    }
    dedupedRows.push(row);
  }

  const insertStmt = db.prepare(
    `INSERT INTO trades
     (trade_date, trade_time, symbol, security_name, trade_no, side, price, quantity, amount, fee, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const trx = db.transaction(() => {
    for (const row of dedupedRows) {
      insertStmt.run(
        row.trade_date,
        row.trade_time,
        row.symbol,
        row.security_name,
        row.trade_no || null,
        row.side,
        row.price,
        row.quantity,
        row.amount,
        row.fee,
        row.source,
        now()
      );
    }
    rebuildSellMatches();
  });

  trx();
  return { ok: true, inserted: dedupedRows.length, skipped };
}

function updateTrade(input) {
  if (!input || !input.id) throw new Error("缺少交易ID");
  const normalized = normalizeTradeInput(input);
  validateTrade(normalized);

  const old = db.prepare("SELECT * FROM trades WHERE id = ?").get(input.id);
  if (!old) throw new Error("交易记录不存在");
  if (normalized.trade_no) {
    const sameNo = db.prepare("SELECT id FROM trades WHERE trade_no = ? LIMIT 1").get(normalized.trade_no);
    if (sameNo && Number(sameNo.id) !== Number(input.id)) {
      throw new Error("成交编号已存在");
    }
  }
  const amount = round2(Number(normalized.price) * Number(normalized.quantity));
  const fee = calcFee(normalized.side, amount);
  const trx = db.transaction(() => {
    db.prepare(
      `UPDATE trades
       SET trade_date = ?, trade_time = ?, symbol = ?, security_name = ?, trade_no = ?, side = ?, price = ?, quantity = ?, amount = ?, fee = ?
       WHERE id = ?`
    ).run(
      normalized.trade_date,
      normalized.trade_time,
      normalized.symbol,
      normalized.security_name,
      normalized.trade_no || null,
      normalized.side,
      Number(normalized.price),
      Number(normalized.quantity),
      amount,
      fee,
      input.id
    );

    rebuildSellMatches();
  });

  trx();

  return { ok: true };
}

function deleteTrade(id) {
  const tradeId = Number(id);
  if (!Number.isInteger(tradeId) || tradeId <= 0) {
    throw new Error("交易ID必须是正整数");
  }
  const trade = db.prepare("SELECT * FROM trades WHERE id = ?").get(tradeId);
  if (!trade) throw new Error("交易记录不存在");

  const trx = db.transaction(() => {
    if (trade.side === "SELL") {
      db.prepare("DELETE FROM sell_matches WHERE sell_trade_id = ?").run(trade.id);
    }

    db.prepare("DELETE FROM trades WHERE id = ?").run(trade.id);
    rebuildSellMatches();
  });

  try {
    trx();
  } catch (e) {
    throw new Error(`删除失败：${e instanceof Error ? e.message : String(e)}`);
  }

  return { ok: true };
}

function clearAllTrades(confirmText) {
  const text = String(confirmText || "").trim();
  if (text !== CLEAR_ALL_TRADES_CONFIRM_TEXT) {
    throw new Error("确认词不正确，已取消清除操作");
  }

  const counts = db
    .prepare(
      `SELECT
        (SELECT COUNT(1) FROM trades) AS trade_count,
        (SELECT COUNT(1) FROM sell_matches) AS match_count`
    )
    .get();

  const trx = db.transaction(() => {
    db.prepare("DELETE FROM sell_matches").run();
    db.prepare("DELETE FROM trades").run();
    db.prepare(
      `UPDATE app_settings
       SET ai_base_url = '', ai_api_key = '', ai_model = '', ai_profiles_json = '[]', active_ai_profile_id = '', updated_at = ?
       WHERE id = 1`
    ).run(now());
  });
  trx();

  return {
    ok: true,
    deletedTrades: Number(counts?.trade_count || 0),
    deletedMatches: Number(counts?.match_count || 0),
  };
}

function listTrades() {
  const rows = db
    .prepare(
      `SELECT t.*, COALESCE(m.matched_qty, 0) AS matched_qty
       FROM trades t
       LEFT JOIN (
         SELECT buy_trade_id, SUM(matched_qty) AS matched_qty
         FROM sell_matches
         GROUP BY buy_trade_id
       ) m ON m.buy_trade_id = t.id
       ORDER BY t.trade_date DESC, t.trade_time DESC, t.id DESC`
    )
    .all();
  return rows;
}

function computeSummary() {
  const settings = getSettings();
  const realized = db.prepare("SELECT COALESCE(SUM(net_profit), 0) AS v FROM sell_matches").get().v;
  const fees = db.prepare("SELECT COALESCE(SUM(fee), 0) AS v FROM trades").get().v;

  const symbols = db.prepare("SELECT DISTINCT symbol FROM trades").all().map((r) => r.symbol);
  const positions = symbols.map((symbol) => {
    const buys = db.prepare("SELECT COALESCE(SUM(quantity), 0) AS v FROM trades WHERE symbol = ? AND side = 'BUY'").get(symbol).v;
    const sells = db.prepare("SELECT COALESCE(SUM(quantity), 0) AS v FROM trades WHERE symbol = ? AND side = 'SELL'").get(symbol).v;
    return { symbol, quantity: buys - sells };
  });

  const holdingRows = db
    .prepare(
      `SELECT t.id, t.symbol, t.security_name, t.price, t.quantity,
              COALESCE(m.matched_qty, 0) AS matched_qty
       FROM trades t
       LEFT JOIN (
         SELECT buy_trade_id, SUM(matched_qty) AS matched_qty
         FROM sell_matches
         GROUP BY buy_trade_id
       ) m ON m.buy_trade_id = t.id
       WHERE t.side = 'BUY'`
    )
    .all();

  const holdingMap = new Map();
  for (const r of holdingRows) {
    const remainingQty = Number(r.quantity) - Number(r.matched_qty || 0);
    if (remainingQty <= 0) continue;
    const value = round2(Number(r.price) * remainingQty);
    const key = String(r.symbol);
    const prev = holdingMap.get(key) || {
      symbol: r.symbol,
      security_name: r.security_name,
      quantity: 0,
      total_value: 0,
    };
    prev.quantity += remainingQty;
    prev.total_value = round2(prev.total_value + value);
    holdingMap.set(key, prev);
  }

  const holdings = Array.from(holdingMap.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));

  const costTradeRows = db
    .prepare(
      `SELECT t.id, t.trade_date, t.trade_time, t.symbol, t.security_name, t.trade_no, t.price, t.quantity, t.fee,
              COALESCE(m.matched_qty, 0) AS matched_qty
       FROM trades t
       LEFT JOIN (
         SELECT buy_trade_id, SUM(matched_qty) AS matched_qty
         FROM sell_matches
         GROUP BY buy_trade_id
       ) m ON m.buy_trade_id = t.id
       WHERE t.side = 'BUY'
       ORDER BY t.trade_date DESC, t.trade_time DESC, t.id DESC`
    )
    .all();

  const costTrades = [];
  for (const r of costTradeRows) {
    const remainingQty = Number(r.quantity) - Number(r.matched_qty || 0);
    if (remainingQty <= 0) continue;
    const buyPrice = Number(r.price || 0);
    const buyFee = Number(r.fee || 5);
    const denominator = remainingQty * (1 - 0.0005);
    const breakevenSellPrice = denominator > 0 ? round2((buyPrice * remainingQty + buyFee + 5) / denominator) : 0;
    costTrades.push({
      trade_id: Number(r.id),
      trade_date: r.trade_date,
      trade_time: r.trade_time,
      symbol: r.symbol,
      security_name: r.security_name,
      trade_no: r.trade_no || "",
      buy_price: buyPrice,
      remaining_qty: remainingQty,
      buy_fee: round2(buyFee),
      breakeven_sell_price: breakevenSellPrice,
    });
  }

  // Enrich holdings with unmatched buy details (top 2 lowest prices)
  for (const h of holdings) {
    const trades = db
      .prepare(
        `SELECT t.id, t.price, t.quantity, COALESCE(m.matched_qty, 0) AS matched_qty
         FROM trades t
         LEFT JOIN (SELECT buy_trade_id, SUM(matched_qty) AS matched_qty FROM sell_matches GROUP BY buy_trade_id) m ON m.buy_trade_id = t.id
         WHERE t.side = 'BUY' AND t.symbol = ?`
      )
      .all(h.symbol);

    const unmatched = [];
    for (const t of trades) {
      const remaining = Number(t.quantity) - Number(t.matched_qty || 0);
      if (remaining > 0) {
        unmatched.push({
          price: Number(t.price),
          quantity: remaining,
          trade_id: Number(t.id)
        });
      }
    }

    // Sort by price ASC (lowest first), then by date/id to match matching logic order
    unmatched.sort((a, b) => {
      if (a.price !== b.price) return a.price - b.price;
      return a.trade_id - b.trade_id; // Use trade_id as fallback for sorting stability
    });

    h.unmatchedBuys = unmatched.slice(0, 2); // Keep at least 2
  }

  return {
    initialCapital: settings.initial_capital,
    realizedPnl: realized,
    totalFees: fees,
    totalPnl: realized,
    positions,
    holdings,
    costTrades,
  };
}

function listSellMatches() {
  return db
    .prepare(
      `SELECT sm.*, s.symbol, s.security_name, s.trade_date AS sell_trade_date, s.trade_time AS sell_trade_time,
              s.trade_no AS sell_trade_no, b.trade_no AS buy_trade_no
       FROM sell_matches sm
       JOIN trades s ON s.id = sm.sell_trade_id
       JOIN trades b ON b.id = sm.buy_trade_id
       ORDER BY s.trade_date DESC, s.trade_time DESC, sm.sell_trade_id DESC, sm.buy_price ASC, sm.id ASC`
    )
    .all();
}

class AIServiceError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "AIServiceError";
    this.code = code;
    this.statusCode = Number(options.statusCode || 500);
    this.retryable = Boolean(options.retryable);
    this.detail = options.detail ? String(options.detail) : "";
  }
}

function makeAIError(code, message, options = {}) {
  return new AIServiceError(code, message, options);
}

function toErrorMessage(err) {
  if (err instanceof Error) return err.message;
  return String(err || "unknown");
}

function mapAiNetworkError(err, endpoint) {
  const code = String(err?.cause?.code || err?.code || "").trim();
  const name = String(err?.name || "").trim();
  const msg = toErrorMessage(err);
  const baseDetail = `${code || name || "ERR"}: ${msg}`;
  if (name === "AbortError") {
    return makeAIError("AI_UPSTREAM_TIMEOUT", "AI 服务响应超时，请稍后重试", {
      statusCode: 504,
      retryable: true,
      detail: `${baseDetail}; endpoint=${endpoint}`,
    });
  }
  return makeAIError("AI_UPSTREAM_FETCH_FAILED", "AI 服务连接失败，请检查网络或 Base URL", {
    statusCode: 502,
    retryable: ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"].includes(code) || !code,
    detail: `${baseDetail}; endpoint=${endpoint}`,
  });
}

async function requestAIChatCompletions(profile, body) {
  const endpoint = `${profile.base_url.replace(/\/$/, "")}/chat/completions`;
  const maxAttempts = 2;
  const timeoutMs = 20000;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${profile.api_key}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw makeAIError("AI_UPSTREAM_BAD_RESPONSE", `AI 请求失败: ${res.status}`, {
          statusCode: 502,
          retryable: res.status >= 500 || res.status === 429,
          detail: text.slice(0, 500),
        });
      }

      const out = await res.json().catch(() => {
        throw makeAIError("AI_UPSTREAM_BAD_RESPONSE", "AI 返回不是有效 JSON", {
          statusCode: 502,
          retryable: false,
        });
      });
      return out;
    } catch (err) {
      const normalized = err instanceof AIServiceError ? err : mapAiNetworkError(err, endpoint);
      lastErr = normalized;
      if (attempt < maxAttempts && normalized.retryable) {
        continue;
      }
      throw normalized;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr || makeAIError("AI_UNKNOWN", "AI 请求失败", { statusCode: 500 });
}

async function parseImageWithAI(payload) {
  const imageData = String(payload?.imageData || "").trim();
  if (!imageData) throw makeAIError("AI_PAYLOAD_INVALID", "缺少图片数据", { statusCode: 400, retryable: false });

  const settings = getSettings(true);
  const profile = resolveActiveProfile(settings);
  if (!profile.base_url || !profile.api_key || !profile.model) {
    throw makeAIError("AI_CONFIG_INVALID", "请先在设置里填写 AI Base URL、API Key 和 Model", { statusCode: 400, retryable: false });
  }

  const prompt = `你是交易记录提取助手。请从图片中提取交易记录，并严格返回 JSON：\n{
  "rows": [{
    "trade_date": "YYYY-MM-DD",
    "trade_time": "HH:mm:ss",
    "symbol": "000792",
    "security_name": "盐湖股份",
    "trade_no": "成交编号",
    "side": "BUY or SELL",
    "price": 0,
    "quantity": 0
  }]
}\n仅输出 JSON，不要输出其他文字。`;

  const data = await requestAIChatCompletions(profile, {
    model: profile.model,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "image_url",
            image_url: {
              url: imageData,
            },
          },
        ],
      },
    ],
  });
  const content = data.choices?.[0]?.message?.content;
  const contentText = Array.isArray(content)
    ? content.map((c) => (typeof c === "string" ? c : c?.text || "")).join("\n")
    : String(content || "");
  let parsed;
  try {
    parsed = parsePossiblyFencedJson(contentText);
  } catch (err) {
    throw makeAIError("AI_PARSE_FAILED", "AI 返回不是可解析的 JSON", {
      statusCode: 422,
      retryable: false,
      detail: toErrorMessage(err),
    });
  }
  if (!Array.isArray(parsed.rows)) {
    throw makeAIError("AI_PARSE_FAILED", "AI 返回格式不正确：缺少 rows 数组", {
      statusCode: 422,
      retryable: false,
    });
  }
  return normalizeAiRows(parsed.rows);
}

function decodeMaybeMojibake(s) {
  if (typeof s !== "string") return String(s || "");
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  try {
    return iconv.decode(Buffer.from(s, "latin1"), "gbk");
  } catch (_e) {
    return s;
  }
}

function looksBrokenChinese(name) {
  const s = String(name || "");
  if (!s) return true;
  if (s.includes("�")) return true;
  if (/^[\x00-\x1F\x7F]+$/.test(s)) return true;
  if (s.includes("\\")) return true;
  return false;
}

function isSuspiciousAsciiName(code, name) {
  return /^\d{6}$/.test(String(code || "")) && name.length > 0 && name.length < 5 && /^[a-zA-Z0-9\s]+$/.test(name);
}

function finalizeReportName(code, inputName) {
  const c = String(code || "").trim();
  const n = String(inputName || "").trim();
  if (!n || looksBrokenChinese(n) || isSuspiciousAsciiName(c, n)) {
    const guessed = String(guessNameByCode(c) || "").trim();
    if (guessed && !looksBrokenChinese(guessed) && !isSuspiciousAsciiName(c, guessed)) {
      return guessed;
    }
    return c || n || "未知";
  }
  return n;
}

function guessNameByCode(code) {
  const row = db
    .prepare("SELECT security_name FROM trades WHERE symbol = ? AND security_name <> '' ORDER BY id DESC LIMIT 1")
    .get(String(code || ""));
  return row?.security_name || "";
}

function getValue(row, keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && row[k] !== "") return row[k];
  }
  return "";
}

function mapFileRowsToTrades(rows) {
  const out = [];
  for (const r of rows) {
    const d = String(getValue(r, ["成交日期", "³É½»ÈÕÆÚ"]) || "").trim();
    const t = String(getValue(r, ["成交时间", "³É½»Ê±¼ä"]) || "").trim();
    const symbol = String(getValue(r, ["证券代码", "Ö¤È¯´úÂë"]) || "").trim();
    const name = decodeMaybeMojibake(String(getValue(r, ["证券名称", "Ö¤È¯Ãû³Æ"]) || "")).trim();
    const tradeNo = String(getValue(r, ["成交编号", "³É½»±àºÅ"]) || "").trim();
    const sideText = String(getValue(r, ["买卖标志", "ÂòÂô±êÖ¾"]) || "").trim();
    const price = Number(getValue(r, ["成交价格", "³É½»¼Û¸ñ"]) || 0);
    const quantity = Number(getValue(r, ["成交数量", "³É½»ÊýÁ¿"]) || 0);
    const amount = Number(getValue(r, ["成交金额", "³É½»½ð¶î"]) || 0);
    if (!d || !t || !symbol || !name || !price || !quantity) continue;
    const date = /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;
    const side = mapSideFromText(sideText);
    out.push({ trade_date: date, trade_time: to24h(t), symbol, security_name: name, trade_no: tradeNo, side, price, quantity, amount });
  }
  return normalizeAiRows(out);
}

function parsePossiblyFencedJson(text) {
  if (typeof text !== "string") throw new Error("AI 返回内容不是文本");

  const raw = text.trim();
  try {
    return JSON.parse(raw);
  } catch (_e) {}

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced && fenced[1]) {
    return JSON.parse(fenced[1].trim());
  }

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(raw.slice(start, end + 1));
  }

  throw new Error("AI 返回不是可解析的 JSON");
}

function normalizeAiRows(rows) {
  const today = todayDate();
  return rows
    .map((r) => {
      const tradeDate = String(r.trade_date || "").trim();
      const tradeTime = String(r.trade_time || "").trim();
      const price = Number(r.price || 0);
      const quantity = Number(r.quantity || 0);
      const amountRaw = r.amount;
      const hasAmount = amountRaw !== undefined && amountRaw !== null && String(amountRaw).trim() !== "";
      const amount = hasAmount ? Number(amountRaw) : round2(price * quantity);
      const side = mapSideFromText(r.side);
      return {
        ...r,
        trade_date: tradeDate || today,
        trade_time: to24h(tradeTime),
        trade_no: String(r.trade_no || "").trim(),
        side,
        amount: Number.isFinite(amount) ? round2(amount) : round2(price * quantity),
      };
    })
    .filter((r) => r.trade_date && r.trade_time && r.symbol && r.security_name && r.side && Number(r.price) > 0 && Number(r.quantity) > 0);
}

function parseFileWithAI(payload) {
  const fileName = String(payload?.fileName || "");
  const base64Data = String(payload?.base64Data || "");
  if (!fileName || !base64Data) {
    throw new Error("缺少文件名或文件数据");
  }
  const ext = fileName.toLowerCase().split(".").pop() || "";
  const buf = Buffer.from(base64Data, "base64");

  if (["xls", "xlsx", "csv"].includes(ext)) {
    const wb = XLSX.read(buf, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
    return mapFileRowsToTrades(rows);
  }

  throw new Error("暂仅支持 xls/xlsx/csv 文件识别");
}

function migrateTradeNoUnique() {
  const rows = db
    .prepare("SELECT id, trade_no FROM trades WHERE trade_no IS NOT NULL AND TRIM(trade_no) <> '' ORDER BY id ASC")
    .all();
  const seen = new Set();
  const toDelete = [];
  for (const r of rows) {
    const no = String(r.trade_no || "").trim();
    if (!no) continue;
    if (seen.has(no)) toDelete.push(Number(r.id));
    else seen.add(no);
  }
  const delStmt = db.prepare("DELETE FROM trades WHERE id = ?");
  const trx = db.transaction(() => {
    for (const id of toDelete) delStmt.run(id);
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_trade_no_unique ON trades(trade_no) WHERE trade_no IS NOT NULL AND trade_no <> ''").run();
    rebuildSellMatches();
  });
  trx();
  return { ok: true, removed: toDelete.length };
}

function saveAiReport(input) {
  const code = String(input.code || "");
  const finalName = finalizeReportName(code, input.name);

  db.prepare(
    `INSERT INTO ai_reports (code, name, analysis_type, content, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    String(input.code || ""),
    String(finalName || ""),
    String(input.analysis_type || "f10"),
    String(input.content || ""),
    now()
  );
  return { ok: true };
}

function listAiReports(code = "") {
  if (code) {
    return db
      .prepare("SELECT * FROM ai_reports WHERE code = ? ORDER BY created_at DESC, id DESC")
      .all(code)
      .map((r) => ({ ...r, name: String(r.name || "").trim() }));
  }
  return db
    .prepare("SELECT * FROM ai_reports ORDER BY created_at DESC, id DESC LIMIT 500")
    .all()
    .map((r) => ({ ...r, name: String(r.name || "").trim() }));
}

function migrateAiReportNamesStable() {
  const rows = db.prepare("SELECT id, code, name FROM ai_reports").all();
  const stmt = db.prepare("UPDATE ai_reports SET name = ? WHERE id = ?");
  let changed = 0;
  const trx = db.transaction(() => {
    for (const r of rows) {
      const n = finalizeReportName(r.code, r.name);
      if (n && n !== r.name) {
        stmt.run(n, r.id);
        changed += 1;
      }
    }
  });
  trx();
  return { ok: true, changed };
}

function deleteAiReport(id) {
  const n = db.prepare("DELETE FROM ai_reports WHERE id = ?").run(Number(id)).changes;
  return { ok: n > 0 };
}

function exportBackupData() {
  const settings = getSettings(true);
  const trades = db.prepare("SELECT * FROM trades ORDER BY id ASC").all();
  const sellMatches = db.prepare("SELECT * FROM sell_matches ORDER BY id ASC").all();
  const aiReports = db.prepare("SELECT * FROM ai_reports ORDER BY id ASC").all();
  return {
    backup_version: "backup_v1",
    exported_at: now(),
    meta: {
      app: "stock-trade-local-app",
      format: "json",
    },
    app_settings: settings,
    trades,
    sell_matches: sellMatches,
    ai_reports: aiReports,
  };
}

function importBackupData(payload) {
  const data = payload && typeof payload === "object" ? payload : null;
  if (!data) throw new Error("备份数据格式错误");
  if (!Array.isArray(data.trades) || !Array.isArray(data.ai_reports)) {
    throw new Error("备份数据缺少必要字段：trades 或 ai_reports");
  }

  const mode = String(payload?.mode || "merge").trim().toLowerCase() === "replace" ? "replace" : "merge";
  const overwriteSecrets = Boolean(payload?.overwriteSecrets);

  const backupSettings = data.app_settings && typeof data.app_settings === "object" ? data.app_settings : null;
  const trades = data.trades;
  const aiReports = data.ai_reports;

  const result = {
    ok: true,
    mode,
    importedTrades: 0,
    skippedTrades: 0,
    importedReports: 0,
    skippedReports: 0,
    replaced: false,
  };

  const insertTradeStmt = db.prepare(
    `INSERT INTO trades
     (id, trade_date, trade_time, symbol, security_name, trade_no, side, price, quantity, amount, fee, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertReportStmt = db.prepare(
    `INSERT INTO ai_reports
     (id, code, name, analysis_type, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const maxTradeIdStmt = db.prepare("SELECT COALESCE(MAX(id), 0) AS v FROM trades");
  const maxReportIdStmt = db.prepare("SELECT COALESCE(MAX(id), 0) AS v FROM ai_reports");
  const resetTradeSeqStmt = db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'trades'");
  const resetReportSeqStmt = db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'ai_reports'");

  const trx = db.transaction(() => {
    if (mode === "replace") {
      db.prepare("DELETE FROM sell_matches").run();
      db.prepare("DELETE FROM trades").run();
      db.prepare("DELETE FROM ai_reports").run();
      result.replaced = true;
    }

    for (const r of trades) {
      const normalized = normalizeTradeInput({
        trade_date: r.trade_date,
        trade_time: r.trade_time,
        symbol: r.symbol,
        security_name: r.security_name,
        trade_no: r.trade_no,
        side: r.side,
        price: r.price,
        quantity: r.quantity,
        source: r.source || "MANUAL",
      });
      validateTrade(normalized);
      const amount = round2(Number(normalized.price) * Number(normalized.quantity));
      const fee = calcFee(normalized.side, amount);

      const id = Number(r.id || 0);
      const createdAt = String(r.created_at || now());

      if (mode === "merge") {
        const idExists = id > 0 ? db.prepare("SELECT id FROM trades WHERE id = ? LIMIT 1").get(id) : null;
        const no = String(normalized.trade_no || "").trim();
        const noExists = no ? findTradeByTradeNo(no) : null;
        if (idExists || noExists) {
          result.skippedTrades += 1;
          continue;
        }
      }

      insertTradeStmt.run(
        id > 0 ? id : null,
        normalized.trade_date,
        normalized.trade_time,
        normalized.symbol,
        normalized.security_name,
        normalized.trade_no || null,
        normalized.side,
        Number(normalized.price),
        Number(normalized.quantity),
        amount,
        fee,
        normalized.source,
        createdAt
      );
      result.importedTrades += 1;
    }

    for (const r of aiReports) {
      const id = Number(r.id || 0);
      const code = String(r.code || "").trim();
      const name = String(r.name || "").trim();
      const analysisType = String(r.analysis_type || "f10").trim();
      const content = String(r.content || "");
      const createdAt = String(r.created_at || now());
      if (!code || !analysisType || !content) {
        result.skippedReports += 1;
        continue;
      }

      if (mode === "merge") {
        const idExists = id > 0 ? db.prepare("SELECT id FROM ai_reports WHERE id = ? LIMIT 1").get(id) : null;
        if (idExists) {
          result.skippedReports += 1;
          continue;
        }
      }

      insertReportStmt.run(id > 0 ? id : null, code, name, analysisType, content, createdAt);
      result.importedReports += 1;
    }

    if (backupSettings) {
      const current = getSettings(true);
      const incomingProfiles = Array.isArray(backupSettings.ai_profiles) ? backupSettings.ai_profiles : [];
      const sanitizedProfiles = incomingProfiles.map((p) => ({
        id: String(p?.id || ""),
        name: String(p?.name || ""),
        base_url: String(p?.base_url || ""),
        api_key: overwriteSecrets ? String(p?.api_key || "") : "",
        model: String(p?.model || ""),
      }));

      const nextSettings = {
        initial_capital: Number(backupSettings.initial_capital || 0),
        ai_base_url: String(backupSettings.ai_base_url || ""),
        ai_api_key: overwriteSecrets ? String(backupSettings.ai_api_key || "") : String(current.ai_api_key || ""),
        ai_model: String(backupSettings.ai_model || ""),
        ai_profiles: overwriteSecrets
          ? sanitizedProfiles
          : sanitizedProfiles.map((p) => {
              const old = (current.ai_profiles || []).find((x) => String(x.id) === String(p.id));
              return { ...p, api_key: String(old?.api_key || "") };
            }),
        active_ai_profile_id: String(backupSettings.active_ai_profile_id || ""),
      };
      saveSettings(nextSettings);
    }

    rebuildSellMatches();

    const maxTradeId = Number(maxTradeIdStmt.get().v || 0);
    const maxReportId = Number(maxReportIdStmt.get().v || 0);
    try {
      resetTradeSeqStmt.run(maxTradeId);
    } catch (_e) {}
    try {
      resetReportSeqStmt.run(maxReportId);
    } catch (_e) {}
  });

  trx();
  return result;
}

module.exports = {
  initDb,
  createTrade,
  createTradesBulk,
  updateTrade,
  deleteTrade,
  clearAllTrades,
  listTrades,
  saveSettings,
  getSettings,
  computeSummary,
  listSellMatches,
  parseImageWithAI,
  parseFileWithAI,
  saveAiReport,
  listAiReports,
  migrateAiReportNamesStable,
  migrateTradeNoUnique,
  deleteAiReport,
  exportBackupData,
  importBackupData,
  hasAppPassword,
  setupAppPassword,
  verifyAppPassword,
  changeAppPassword,
  clearAppPasswordLock,
};
