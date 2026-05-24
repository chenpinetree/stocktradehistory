const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const {
  initDb,
  createTrade,
  createTradesBulk,
  updateTrade,
  deleteTrade,
  clearAllTrades,
  listTrades,
  listSellMatches,
  getSettings,
  saveAiReport,
  listAiReports,
  migrateTradeNoUnique,
  parseImageWithAI,
  parseFileWithAI,
  saveSettings,
  computeSummary,
  exportBackupData,
  importBackupData,
} = require("./services.cjs");

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trade-db-"));
  return path.join(dir, "test.db");
}

test("sell matching uses lowest buy price first", () => {
  const dbPath = makeTempDb();
  initDb(dbPath);

  createTrade({ trade_date: "2026-03-16", trade_time: "10:00:00 AM", symbol: "000792", security_name: "盐湖股份", side: "BUY", price: 37.5, quantity: 200, source: "MANUAL" });
  createTrade({ trade_date: "2026-03-16", trade_time: "10:05:00 AM", symbol: "000792", security_name: "盐湖股份", side: "BUY", price: 37.0, quantity: 200, source: "MANUAL" });
  createTrade({ trade_date: "2026-03-16", trade_time: "10:10:00 AM", symbol: "000792", security_name: "盐湖股份", side: "BUY", price: 36.9, quantity: 200, source: "MANUAL" });
  createTrade({ trade_date: "2026-03-16", trade_time: "10:15:00 AM", symbol: "000792", security_name: "盐湖股份", side: "BUY", price: 36.7, quantity: 100, source: "MANUAL" });
  createTrade({ trade_date: "2026-03-17", trade_time: "09:30:00 AM", symbol: "000792", security_name: "盐湖股份", side: "BUY", price: 36.75, quantity: 300, source: "MANUAL" });

  createTrade({ trade_date: "2026-03-26", trade_time: "09:31:00 AM", symbol: "000792", security_name: "盐湖股份", side: "SELL", price: 38.0, quantity: 1000, source: "MANUAL" });

  const matches = listSellMatches();
  assert.equal(matches.length, 5);
  assert.deepEqual(
    matches.map((m) => [m.buy_price, m.matched_qty]),
    [
      [36.7, 100],
      [36.75, 300],
      [36.9, 200],
      [37.0, 200],
      [37.5, 200],
    ]
  );
});

test("settings:get does not expose plaintext API keys", () => {
  const dbPath = makeTempDb();
  initDb(dbPath);

  saveSettings({
    initial_capital: 10000,
    ai_base_url: "https://api.example.com/v1",
    ai_api_key: "plain-root-key",
    ai_model: "model-a",
    ai_profiles: [
      { id: "p1", name: "P1", base_url: "https://api.example.com/v1", api_key: "plain-profile-key", model: "model-a" },
    ],
    active_ai_profile_id: "p1",
  });

  const settings = getSettings();
  assert.equal(settings.ai_api_key, "");
  assert.equal(settings.ai_profiles[0].api_key, "");
});

test("createTrade normalizes AM/PM time to 24h before validation", () => {
  const dbPath = makeTempDb();
  initDb(dbPath);

  createTrade({
    trade_date: "2026-05-08",
    trade_time: "10:05:00 PM",
    symbol: "000001",
    security_name: "平安银行",
    side: "BUY",
    price: 10,
    quantity: 100,
    source: "MANUAL",
  });

  const rows = listTrades();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].trade_time, "22:05:00");
});

test("createTrade rejects invalid time format", () => {
  const dbPath = makeTempDb();
  initDb(dbPath);

  assert.throws(
    () =>
      createTrade({
        trade_date: "2026-05-08",
        trade_time: "10:05",
        symbol: "000001",
        security_name: "平安银行",
        side: "BUY",
        price: 10,
        quantity: 100,
        source: "MANUAL",
      }),
    /时间格式错误/
  );
});

test("parseFileWithAI maps buy/sell markers via whitelist and rejects unknown side", () => {
  const dbPath = makeTempDb();
  initDb(dbPath);

  const okCsv = [
    "成交日期,成交时间,证券代码,证券名称,买卖标志,成交价格,成交数量,成交金额,成交编号",
    "20260508,10:00:00,000001,平安银行,证券买入,10.00,100,1000,TN-001",
    "20260508,10:05:00,000001,平安银行,证券卖出,10.20,100,1020,TN-002",
  ].join("\n");

  const okRows = parseFileWithAI({
    fileName: "ok.csv",
    base64Data: Buffer.from(okCsv, "utf8").toString("base64"),
  });

  assert.equal(okRows.length, 2);
  assert.equal(okRows[0].side, "BUY");
  assert.equal(okRows[1].side, "SELL");
  assert.equal(okRows[0].trade_no, "TN-001");

  const badCsv = [
    "成交日期,成交时间,证券代码,证券名称,买卖标志,成交价格,成交数量,成交金额",
    "20260508,10:00:00,000001,平安银行,未知标志,10.00,100,1000",
  ].join("\n");

  assert.throws(
    () =>
      parseFileWithAI({
        fileName: "bad.csv",
        base64Data: Buffer.from(badCsv, "utf8").toString("base64"),
      }),
    /买卖标志不支持/
  );
});

test("createTradesBulk rolls back all rows when any row is invalid", () => {
  const dbPath = makeTempDb();
  initDb(dbPath);

  assert.throws(
    () =>
      createTradesBulk([
        { trade_date: "2026-05-08", trade_time: "10:00:00", symbol: "000001", security_name: "平安银行", side: "BUY", price: 10, quantity: 100, source: "AI" },
        { trade_date: "2026-05-08", trade_time: "10:01:00", symbol: "000001", security_name: "平安银行", side: "UNKNOWN", price: 10, quantity: 100, source: "AI" },
      ]),
    /买卖标志必须是 BUY 或 SELL/
  );

  const rows = listTrades();
  assert.equal(rows.length, 0);
});

test("createTradesBulk generates same matching result as sequential createTrade", () => {
  const rows = [
    { trade_date: "2026-03-16", trade_time: "10:00:00", symbol: "000792", security_name: "盐湖股份", side: "BUY", price: 37.5, quantity: 200, source: "AI" },
    { trade_date: "2026-03-16", trade_time: "10:05:00", symbol: "000792", security_name: "盐湖股份", side: "BUY", price: 37.0, quantity: 200, source: "AI" },
    { trade_date: "2026-03-16", trade_time: "10:10:00", symbol: "000792", security_name: "盐湖股份", side: "BUY", price: 36.9, quantity: 200, source: "AI" },
    { trade_date: "2026-03-16", trade_time: "10:15:00", symbol: "000792", security_name: "盐湖股份", side: "BUY", price: 36.7, quantity: 100, source: "AI" },
    { trade_date: "2026-03-17", trade_time: "09:30:00", symbol: "000792", security_name: "盐湖股份", side: "BUY", price: 36.75, quantity: 300, source: "AI" },
    { trade_date: "2026-03-26", trade_time: "09:31:00", symbol: "000792", security_name: "盐湖股份", side: "SELL", price: 38.0, quantity: 1000, source: "AI" },
  ];

  const db1 = makeTempDb();
  initDb(db1);
  createTradesBulk(rows);
  const bulkMatches = listSellMatches().map((m) => [m.buy_price, m.matched_qty, m.sell_price, m.net_profit]);

  const db2 = makeTempDb();
  initDb(db2);
  for (const row of rows) createTrade(row);
  const seqMatches = listSellMatches().map((m) => [m.buy_price, m.matched_qty, m.sell_price, m.net_profit]);

  assert.deepEqual(bulkMatches, seqMatches);
});

test("createTrade skips duplicate trade_no globally", () => {
  const dbPath = makeTempDb();
  initDb(dbPath);

  const r1 = createTrade({ trade_date: "2026-05-08", trade_time: "10:00:00", symbol: "000001", security_name: "平安银行", trade_no: "X-001", side: "BUY", price: 10, quantity: 100, source: "MANUAL" });
  const r2 = createTrade({ trade_date: "2026-05-08", trade_time: "10:01:00", symbol: "000002", security_name: "万科A", trade_no: "X-001", side: "BUY", price: 20, quantity: 100, source: "MANUAL" });

  assert.equal(r1.ok, true);
  assert.equal(r2.skipped, true);
  const rows = listTrades();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, "000001");
});

test("createTradesBulk skips duplicate trade_no inside batch and against db", () => {
  const dbPath = makeTempDb();
  initDb(dbPath);

  createTrade({ trade_date: "2026-05-08", trade_time: "09:59:00", symbol: "000001", security_name: "平安银行", trade_no: "B-001", side: "BUY", price: 10, quantity: 100, source: "MANUAL" });
  const result = createTradesBulk([
    { trade_date: "2026-05-08", trade_time: "10:00:00", symbol: "000001", security_name: "平安银行", trade_no: "B-001", side: "BUY", price: 10, quantity: 100, source: "AI" },
    { trade_date: "2026-05-08", trade_time: "10:01:00", symbol: "000001", security_name: "平安银行", trade_no: "B-002", side: "BUY", price: 10, quantity: 100, source: "AI" },
    { trade_date: "2026-05-08", trade_time: "10:02:00", symbol: "000001", security_name: "平安银行", trade_no: "B-002", side: "BUY", price: 10, quantity: 100, source: "AI" },
  ]);

  assert.equal(result.inserted, 1);
  assert.equal(result.skipped, 2);
});

test("parseFileWithAI rejects invalid payload", () => {
  const dbPath = makeTempDb();
  initDb(dbPath);
  assert.throws(() => parseFileWithAI({ fileName: "", base64Data: "" }), /缺少文件名或文件数据/);
  assert.throws(() => parseFileWithAI(undefined), /缺少文件名或文件数据/);
});

test("parseImageWithAI rejects invalid payload before network call", async () => {
  const dbPath = makeTempDb();
  initDb(dbPath);

  await assert.rejects(() => parseImageWithAI(undefined), /缺少图片数据/);
  await assert.rejects(() => parseImageWithAI({ imageData: "" }), /缺少图片数据/);
});

test("parseImageWithAI parses AI result via mocked fetch", async () => {
  const dbPath = makeTempDb();
  initDb(dbPath);

  saveSettings({
    initial_capital: 0,
    ai_base_url: "https://api.example.com/v1",
    ai_api_key: "test-key",
    ai_model: "test-model",
    ai_profiles: [
      { id: "p1", name: "P1", base_url: "https://api.example.com/v1", api_key: "test-key", model: "test-model" },
    ],
    active_ai_profile_id: "p1",
  });

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: "```json\n{\"rows\":[{\"trade_date\":\"2026-05-08\",\"trade_time\":\"10:01:00\",\"symbol\":\"000001\",\"security_name\":\"平安银行\",\"side\":\"BUY\",\"price\":10,\"quantity\":100}]}\n```",
          },
        },
      ],
    }),
  });

  try {
    const rows = await parseImageWithAI({ imageData: "data:image/png;base64,abc" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].symbol, "000001");
    assert.equal(rows[0].side, "BUY");
    assert.equal(rows[0].trade_time, "10:01:00");
  } finally {
    global.fetch = originalFetch;
  }
});

test("parseImageWithAI throws clear error when fetch response is not ok", async () => {
  const dbPath = makeTempDb();
  initDb(dbPath);

  saveSettings({
    initial_capital: 0,
    ai_base_url: "https://api.example.com/v1",
    ai_api_key: "test-key",
    ai_model: "test-model",
    ai_profiles: [
      { id: "p1", name: "P1", base_url: "https://api.example.com/v1", api_key: "test-key", model: "test-model" },
    ],
    active_ai_profile_id: "p1",
  });

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 503,
    text: async () => "service unavailable",
  });

  try {
    await assert.rejects(
      () => parseImageWithAI({ imageData: "data:image/png;base64,abc" }),
      /AI 请求失败: 503 service unavailable/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("updateTrade and deleteTrade reject invalid id", () => {
  const dbPath = makeTempDb();
  initDb(dbPath);
  createTrade({
    trade_date: "2026-05-08",
    trade_time: "10:00:00",
    symbol: "000001",
    security_name: "平安银行",
    side: "BUY",
    price: 10,
    quantity: 100,
    source: "MANUAL",
  });

  assert.throws(() => updateTrade({ id: 999999, trade_date: "2026-05-08", trade_time: "10:00:00", symbol: "000001", security_name: "平安银行", side: "BUY", price: 10, quantity: 100 }), /交易记录不存在/);
  assert.throws(() => deleteTrade(0), /交易ID必须是正整数/);
  assert.throws(() => deleteTrade(Number.NaN), /交易ID必须是正整数/);
});

test("ai report name is finalized at save time and remains stable on read", () => {
  const dbPath = makeTempDb();
  initDb(dbPath);

  createTrade({
    trade_date: "2026-05-08",
    trade_time: "10:00:00",
    symbol: "000001",
    security_name: "平安银行",
    side: "BUY",
    price: 10,
    quantity: 100,
    source: "MANUAL",
  });

  saveAiReport({ code: "000001", name: "k f", analysis_type: "f10", content: "x" });
  let reports = listAiReports("000001");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].name, "平安银行");

  createTrade({
    trade_date: "2026-05-08",
    trade_time: "10:01:00",
    symbol: "000001",
    security_name: "坏名",
    side: "BUY",
    price: 10,
    quantity: 100,
    source: "MANUAL",
  });

  reports = listAiReports("000001");
  assert.equal(reports[0].name, "平安银行");
});

test("clearAllTrades requires exact confirmation text and keeps ai reports", () => {
  const dbPath = makeTempDb();
  initDb(dbPath);

  createTrade({ trade_date: "2026-05-08", trade_time: "10:00:00", symbol: "000001", security_name: "平安银行", trade_no: "CLR-001", side: "BUY", price: 10, quantity: 100, source: "MANUAL" });
  saveAiReport({ code: "000001", name: "平安银行", analysis_type: "f10", content: "report" });
  saveSettings({
    initial_capital: 10000,
    ai_base_url: "https://api.example.com/v1",
    ai_api_key: "secret-key",
    ai_model: "model-a",
    ai_profiles: [{ id: "p1", name: "P1", base_url: "https://api.example.com/v1", api_key: "profile-secret", model: "model-a" }],
    active_ai_profile_id: "p1",
  });

  assert.throws(() => clearAllTrades("我确定清楚所有交易记录"), /确认词不正确/);
  assert.equal(listTrades().length, 1);
  assert.equal(listAiReports().length, 1);

  const res = clearAllTrades("我确定清除所有交易记录");
  assert.equal(res.ok, true);
  assert.equal(res.deletedTrades, 1);
  assert.equal(listTrades().length, 0);
  assert.equal(listSellMatches().length, 0);
  assert.equal(listAiReports().length, 1);
  const settingsAfter = getSettings(true);
  assert.equal(settingsAfter.ai_base_url, "");
  assert.equal(settingsAfter.ai_api_key, "");
  assert.equal(settingsAfter.ai_model, "");
  assert.equal(Array.isArray(settingsAfter.ai_profiles), true);
  assert.equal(settingsAfter.ai_profiles.length, 0);
  assert.equal(settingsAfter.active_ai_profile_id, "");
});

test("listSellMatches includes sell/buy trade numbers", () => {
  const dbPath = makeTempDb();
  initDb(dbPath);
  createTrade({ trade_date: "2026-05-08", trade_time: "10:00:00", symbol: "000001", security_name: "平安银行", trade_no: "SNO-BUY", side: "BUY", price: 10, quantity: 100, source: "MANUAL" });
  createTrade({ trade_date: "2026-05-08", trade_time: "10:10:00", symbol: "000001", security_name: "平安银行", trade_no: "SNO-SELL", side: "SELL", price: 10.5, quantity: 100, source: "MANUAL" });
  const matches = listSellMatches();
  assert.equal(matches.length, 1);
  assert.equal(matches[0].sell_trade_no, "SNO-SELL");
  assert.equal(matches[0].buy_trade_no, "SNO-BUY");
});

test("migrateTradeNoUnique removes duplicate trade_no and keeps earliest", () => {
  const dbPath = makeTempDb();
  initDb(dbPath);
  createTrade({ trade_date: "2026-05-08", trade_time: "10:00:00", symbol: "000001", security_name: "平安银行", trade_no: "M-001", side: "BUY", price: 10, quantity: 100, source: "MANUAL" });
  const res = createTrade({ trade_date: "2026-05-08", trade_time: "10:01:00", symbol: "000001", security_name: "平安银行", trade_no: "M-001", side: "BUY", price: 10, quantity: 100, source: "MANUAL" });
  assert.equal(res.skipped, true);

  const result = migrateTradeNoUnique();
  assert.equal(result.ok, true);
  assert.equal(result.removed, 0);
});

test("SELL fee uses rounded stamp tax rule", () => {
  const dbPath = makeTempDb();
  initDb(dbPath);

  createTrade({ trade_date: "2026-06-01", trade_time: "10:00:00", symbol: "000001", security_name: "平安银行", side: "BUY", price: 10, quantity: 100, source: "MANUAL" });
  createTrade({ trade_date: "2026-06-01", trade_time: "10:01:00", symbol: "000001", security_name: "平安银行", side: "SELL", price: 10.23, quantity: 100, source: "MANUAL" });

  const sell = listTrades().find((x) => x.side === "SELL");
  assert.ok(sell);
  const expected = round2(5 + round2(Number(sell.amount) * 0.0005));
  assert.equal(Number(sell.fee), expected);
});

test("cost trade breakeven price keeps net pnl near zero", () => {
  const dbPath = makeTempDb();
  initDb(dbPath);

  createTrade({ trade_date: "2026-06-02", trade_time: "09:40:00", symbol: "000001", security_name: "平安银行", side: "BUY", price: 12.34, quantity: 300, source: "MANUAL" });
  const summary = computeSummary();
  assert.ok(Array.isArray(summary.costTrades));
  assert.equal(summary.costTrades.length, 1);

  const c = summary.costTrades[0];
  const sellAmount = Number(c.breakeven_sell_price) * Number(c.remaining_qty);
  const sellFee = round2(5 + round2(sellAmount * 0.0005));
  const buyAmount = Number(c.buy_price) * Number(c.remaining_qty);
  const net = round2(sellAmount - buyAmount - Number(c.buy_fee) - sellFee);
  assert.ok(Math.abs(net) <= 0.02);
});

test("exportBackupData returns full backup structure", () => {
  const dbPath = makeTempDb();
  initDb(dbPath);
  createTrade({ trade_date: "2026-06-03", trade_time: "10:00:00", symbol: "000001", security_name: "平安银行", side: "BUY", price: 10, quantity: 100, source: "MANUAL" });
  saveAiReport({ code: "000001", name: "平安银行", analysis_type: "f10", content: "x" });

  const backup = exportBackupData();
  assert.equal(backup.backup_version, "backup_v1");
  assert.ok(Array.isArray(backup.trades));
  assert.ok(Array.isArray(backup.sell_matches));
  assert.ok(Array.isArray(backup.ai_reports));
  assert.ok(backup.app_settings);
  assert.equal(backup.trades.length, 1);
  assert.equal(backup.ai_reports.length, 1);
});

test("importBackupData merge skips duplicated trade_no", () => {
  const dbPath = makeTempDb();
  initDb(dbPath);

  createTrade({ trade_date: "2026-06-03", trade_time: "10:00:00", symbol: "000001", security_name: "平安银行", trade_no: "IMP-001", side: "BUY", price: 10, quantity: 100, source: "MANUAL" });

  const backup = exportBackupData();
  const result = importBackupData({ ...backup, mode: "merge", overwriteSecrets: false });
  assert.equal(result.ok, true);
  assert.equal(result.importedTrades, 0);
  assert.ok(result.skippedTrades >= 1);
});
