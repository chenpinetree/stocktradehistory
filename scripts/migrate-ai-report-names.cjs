const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { initDb, migrateAiReportNamesStable } = require("../electron/services.cjs");

function resolveDbPath() {
  const arg = process.argv[2];
  if (arg) return path.resolve(arg);
  return path.join(os.homedir(), "Library", "Application Support", "stock-trade-local-app", "trade-history.db");
}

function main() {
  const dbPath = resolveDbPath();
  if (!fs.existsSync(dbPath)) {
    throw new Error(`数据库不存在: ${dbPath}`);
  }

  initDb(dbPath);
  const result = migrateAiReportNamesStable();
  process.stdout.write(`AI 报告名称迁移完成: changed=${result.changed}\n`);
}

try {
  main();
} catch (e) {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
}
