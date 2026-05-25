import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Card, Col, DatePicker, Dropdown, Form, Input, InputNumber, message, Modal, Row, Select, Space, Statistic, Table, Tabs, Tag, TimePicker, Typography, Upload } from "antd";
import type { UploadProps } from "antd";
import * as echarts from "echarts";
import dayjs from "dayjs";
import type { Dayjs } from "dayjs";

type Side = "BUY" | "SELL";

type Trade = {
  id: number;
  trade_date: string;
  trade_time: string;
  symbol: string;
  security_name: string;
  trade_no?: string;
  side: Side;
  price: number;
  quantity: number;
  amount: number;
  fee: number;
  source: "MANUAL" | "AI";
  matched_qty?: number;
};

type Settings = {
  initial_capital: number;
  ai_base_url: string;
  ai_api_key: string;
  ai_model: string;
  ai_profiles: AiProfile[];
  active_ai_profile_id: string;
};

type AiProfile = {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  model: string;
};

type AiRow = Omit<Trade, "id" | "fee" | "source">;
type SellMatch = {
  id: number;
  sell_trade_id: number;
  buy_trade_id: number;
  matched_qty: number;
  buy_price: number;
  sell_price: number;
  gross_profit: number;
  allocated_fee: number;
  net_profit: number;
  symbol: string;
  security_name: string;
  sell_trade_date: string;
  sell_trade_time: string;
  sell_trade_no?: string;
  buy_trade_no?: string;
};

type StockQuote = {
  code: string;
  name: string;
  price: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  volumeHands: number;
  turnover: number;
  mainNetInflow: number;
  bidAsk: Array<{ level: number; bidPrice: number; bidVol: number; askPrice: number; askVol: number }>;
  kline: Array<{ date: string; open: number; close: number; high: number; low: number; volume: number }>;
};
type ChartPeriod = "timeline" | "day" | "week";
type StockSearchItem = { code: string; name: string; market: string };
type AiReport = { id: number; code: string; name: string; analysis_type: string; content: string; created_at: string };
type HoldingItem = { symbol: string; security_name: string; quantity: number; total_value: number; unmatchedBuys?: Array<{ price: number; quantity: number }> };
type CostTrade = {
  trade_id: number;
  trade_date: string;
  trade_time: string;
  symbol: string;
  security_name: string;
  trade_no: string;
  buy_price: number;
  remaining_qty: number;
  buy_fee: number;
  breakeven_sell_price: number;
};

const HOLDING_ORDER_KEY = "holding-order-v1";

function moveItem<T>(arr: T[], from: number, to: number) {
  if (from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) return arr;
  const out = [...arr];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}

declare global {
  interface Window {
    api: {
      getSettings: () => Promise<Settings>;
      saveSettings: (payload: Settings) => Promise<Settings>;
      createTrade: (payload: Omit<Trade, "id" | "amount" | "fee"> & { source?: "MANUAL" | "AI" }) => Promise<{ ok: boolean; skipped?: boolean; reason?: string }>;
      createTradesBulk: (payload: { rows: Array<Omit<Trade, "id" | "amount" | "fee"> & { source?: "MANUAL" | "AI" }> }) => Promise<{ ok: boolean; inserted: number; skipped?: number }>;
      updateTrade: (payload: Omit<Trade, "amount" | "fee" | "source">) => Promise<{ ok: boolean }>;
      deleteTrade: (payload: { id: number }) => Promise<{ ok: boolean }>;
      clearAllTrades: (payload: { confirmText: string }) => Promise<{ ok: boolean; deletedTrades: number; deletedMatches: number }>;
      listTrades: () => Promise<Trade[]>;
      getSummary: () => Promise<{
        initialCapital: number;
        realizedPnl: number;
        totalFees: number;
        totalPnl: number;
        positions: Array<{ symbol: string; quantity: number }>;
        holdings: Array<{ symbol: string; security_name: string; quantity: number; total_value: number; unmatchedBuys?: Array<{ price: number; quantity: number }> }>;
        costTrades: CostTrade[];
      }>;
      listSellMatches: () => Promise<SellMatch[]>;
      extractFromImage: (payload: { imageData: string }) => Promise<AiRow[]>;
      extractFromFile: (payload: { fileName: string; base64Data: string }) => Promise<AiRow[]>;
      pollStock: (payload: { code: string; period?: ChartPeriod }) => Promise<StockQuote>;
      stockTimeline: (payload: { code: string; period: ChartPeriod }) => Promise<Array<{ date: string; open: number; close: number; high: number; low: number; volume: number }>>;
      searchStocks: (payload: { keyword: string }) => Promise<StockSearchItem[]>;
      requestAIAnalysis: (payload: { code: string; name?: string; analysisType: "f10" | "orderbook" }) => Promise<{ code: string; name: string; price: number; analysis: string }>;
      listAIReports: (payload: { code?: string }) => Promise<AiReport[]>;
      deleteAIReport: (payload: { id: number }) => Promise<{ ok: boolean }>;
      exportBackupJson: () => Promise<{ ok: boolean; canceled: boolean; filePath?: string }>;
      importBackupJson: (payload: { mode: "merge" | "replace"; overwriteSecrets: boolean }) => Promise<{
        ok: boolean;
        canceled: boolean;
        filePath?: string;
        mode?: string;
        importedTrades?: number;
        skippedTrades?: number;
        importedReports?: number;
        skippedReports?: number;
        replaced?: boolean;
      }>;
      authStatus: () => Promise<{ enabled: boolean; authenticated: boolean }>;
      setupPassword: (payload: { password: string }) => Promise<{ ok: boolean; sessionToken: string }>;
      login: (payload: { password: string }) => Promise<{ ok: boolean; sessionToken: string }>;
      logout: () => Promise<{ ok: boolean }>;
      changePassword: (payload: { oldPassword: string; newPassword: string }) => Promise<{ ok: boolean }>;
    };
  }
}

const emptyTrade = {
  trade_date: "",
  trade_time: "",
  symbol: "",
  security_name: "",
  trade_no: "",
  side: "BUY" as Side,
  price: "",
  quantity: "",
};

function fmtMoney(v: number) {
  return Number(v).toFixed(2);
}

function round2(n: number) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function fmtLocalReportTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `日期：${y}-${m}-${day}  时间：${hh}:${mm}:${ss}`;
}

function errText(e: unknown) {
  if (e instanceof Error) {
    return e.message.replace(/^Error invoking remote method '[^']+':\s*/i, "");
  }
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  try {
    return JSON.stringify(e);
  } catch (_err) {
    return String(e);
  }
}

function toNum(v: unknown) {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const fullwidthDigits = "０１２３４５６７８９";
    let s = v
      .split("")
      .map((ch) => {
        const i = fullwidthDigits.indexOf(ch);
        if (i >= 0) return String(i);
        if (ch === "．" || ch === "。") return ".";
        if (ch === "－") return "-";
        if (ch === "，") return ",";
        return ch;
      })
      .join("")
      .replace(/,/g, "")
      .replace(/\s+/g, "")
      .trim();
    if (!s) return NaN;

    if (!/^[-+]?\d*\.?\d+$/.test(s)) {
      const m = s.match(/[-+]?\d*\.?\d+/);
      s = m ? m[0] : "";
    }
    if (!s) return NaN;
    return Number(s);
  }
  if (v && typeof v === "object") {
    const s = typeof (v as { toString?: () => string }).toString === "function" ? (v as { toString: () => string }).toString() : "";
    if (s && s !== "[object Object]") return toNum(s);
  }
  return Number(v as number);
}

function normalizeAiExtractRows(result: unknown) {
  if (Array.isArray(result)) return result as AiRow[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as AiRow[];
  }
  throw new Error("AI 返回格式异常：缺少 rows 数组");
}

function aiErrorMessage(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err || "识别失败");
  const code = typeof err === "object" && err && "code" in err ? String((err as { code?: unknown }).code || "") : "";
  if (code === "AI_UPSTREAM_FETCH_FAILED" || code === "AI_UPSTREAM_TIMEOUT") {
    return "AI 服务不可达，请检查 NAS 到 AI 主机网络及 Base URL 配置";
  }
  if (code === "AI_CONFIG_INVALID") {
    return "AI 配置不完整，请检查 Base URL / API Key / Model";
  }
  if (code === "AI_PARSE_FAILED") {
    return "AI 返回格式不符合要求，请更换模型或调整提示词";
  }
  return msg;
}

function App() {
  const [settings, setSettings] = useState<Settings>({ initial_capital: 0, ai_base_url: "", ai_api_key: "", ai_model: "", ai_profiles: [], active_ai_profile_id: "" });
  const [trades, setTrades] = useState<Trade[]>([]);
  const [summary, setSummary] = useState({
    initialCapital: 0,
    realizedPnl: 0,
    totalFees: 0,
    totalPnl: 0,
    positions: [] as Array<{ symbol: string; quantity: number }>,
    holdings: [] as Array<{ symbol: string; security_name: string; quantity: number; total_value: number; unmatchedBuys?: Array<{ price: number; quantity: number }> }>,
    costTrades: [] as CostTrade[],
  });
  const [tradeForm] = Form.useForm();
  const [capitalForm] = Form.useForm();
  const [aiForm] = Form.useForm();
  const [aiRows, setAiRows] = useState<AiRow[]>([]);
  const [sellMatches, setSellMatches] = useState<SellMatch[]>([]);
  const [uploading, setUploading] = useState(false);
  const [fileUploading, setFileUploading] = useState(false);
  const [editingTrade, setEditingTrade] = useState<Trade | null>(null);
  const [editForm] = Form.useForm();
  const [filters, setFilters] = useState({ date: "", symbol: "", name: "", side: "", deducted: "" });
  const [profileForm] = Form.useForm();
  const [quotes, setQuotes] = useState<Record<string, StockQuote>>({});
  const chartRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [periods, setPeriods] = useState<Record<string, ChartPeriod>>({});
  const [analysisKeyword, setAnalysisKeyword] = useState("");
  const [analysisTargets, setAnalysisTargets] = useState<StockSearchItem[]>([]);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisText, setAnalysisText] = useState("");
  const [analysisMeta, setAnalysisMeta] = useState<{ code: string; name: string; price: number } | null>(null);
  const [reports, setReports] = useState<AiReport[]>([]);
  const [marketSearchOptions, setMarketSearchOptions] = useState<StockSearchItem[]>([]);
  const [marketSearching, setMarketSearching] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [passwordEnabled, setPasswordEnabled] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");
  const [newPasswordInput, setNewPasswordInput] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [changePwdOpen, setChangePwdOpen] = useState(false);
  const [changePwdOld, setChangePwdOld] = useState("");
  const [changePwdNew, setChangePwdNew] = useState("");
  const [changePwdConfirm, setChangePwdConfirm] = useState("");
  const [holdingOrder, setHoldingOrder] = useState<string[]>([]);
  const [draggingSymbol, setDraggingSymbol] = useState<string | null>(null);
  const dragSourceRef = useRef<string | null>(null);
  const pollInFlightRef = useRef(false);
  const [activeTab, setActiveTab] = useState("list");
  const [aiSettingsModalOpen, setAiSettingsModalOpen] = useState(false);
  const [capitalModalOpen, setCapitalModalOpen] = useState(false);
  const [clearModalOpen, setClearModalOpen] = useState(false);
  const [clearConfirmText, setClearConfirmText] = useState("");
  const [clearingTrades, setClearingTrades] = useState(false);
  const [costSellPrices, setCostSellPrices] = useState<Record<number, number>>({});
  const [costPriceSort, setCostPriceSort] = useState<"asc" | "desc">("asc");
  const [selectedHoldingName, setSelectedHoldingName] = useState("");

  const holdingSymbolOptions = useMemo(
    () => (summary.holdings || []).map((h) => ({ label: `${h.symbol} ${h.security_name}`, value: h.symbol })),
    [summary.holdings]
  );
  const holdingNameOptions = useMemo(
    () => (summary.holdings || []).map((h) => ({ label: `${h.security_name} (${h.symbol})`, value: h.security_name })),
    [summary.holdings]
  );
  const holdingMapBySymbol = useMemo(() => {
    const m = new Map<string, string>();
    (summary.holdings || []).forEach((h) => m.set(h.symbol, h.security_name));
    return m;
  }, [summary.holdings]);
  const holdingMapByName = useMemo(() => {
    const m = new Map<string, string>();
    (summary.holdings || []).forEach((h) => m.set(h.security_name, h.symbol));
    return m;
  }, [summary.holdings]);

  const orderedHoldings = useMemo(() => {
    const holdings = (summary.holdings || []) as HoldingItem[];
    if (!holdings.length) return holdings;
    const pos = new Map<string, number>();
    holdingOrder.forEach((s, i) => pos.set(s, i));
    return [...holdings].sort((a, b) => {
      const ia = pos.has(a.symbol) ? Number(pos.get(a.symbol)) : Number.MAX_SAFE_INTEGER;
      const ib = pos.has(b.symbol) ? Number(pos.get(b.symbol)) : Number.MAX_SAFE_INTEGER;
      if (ia !== ib) return ia - ib;
      return a.symbol.localeCompare(b.symbol);
    });
  }, [summary.holdings, holdingOrder]);

  const reorderHolding = (fromSymbol: string, toSymbol: string) => {
    if (!fromSymbol || !toSymbol || fromSymbol === toSymbol) return;
    const oldIndex = orderedHoldings.findIndex((h) => h.symbol === fromSymbol);
    const newIndex = orderedHoldings.findIndex((h) => h.symbol === toSymbol);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = moveItem(orderedHoldings.map((h) => h.symbol), oldIndex, newIndex);
    setHoldingOrder(next);
  };

  const onHoldingDragStart = (symbol: string) => {
    dragSourceRef.current = symbol;
    setDraggingSymbol(symbol);
  };

  const onHoldingDrop = (targetSymbol: string) => {
    const fromSymbol = dragSourceRef.current;
    dragSourceRef.current = null;
    setDraggingSymbol(null);
    if (!fromSymbol) return;
    reorderHolding(fromSymbol, targetSymbol);
  };

  const onHoldingDragEnd = () => {
    dragSourceRef.current = null;
    setDraggingSymbol(null);
  };

  const mergedSymbolOptions = useMemo(() => {
    const map = new Map<string, { label: string; value: string }>();
    holdingSymbolOptions.forEach((o) => map.set(o.value, o));
    marketSearchOptions.forEach((s) => {
      if (!map.has(s.code)) map.set(s.code, { value: s.code, label: `${s.code} ${s.name}` });
    });
    return Array.from(map.values());
  }, [holdingSymbolOptions, marketSearchOptions]);

  const mergedNameOptions = useMemo(() => {
    const map = new Map<string, { label: string; value: string }>();
    holdingNameOptions.forEach((o) => map.set(o.value, o));
    marketSearchOptions.forEach((s) => {
      if (!map.has(s.name)) map.set(s.name, { value: s.name, label: `${s.name} (${s.code})` });
    });
    return Array.from(map.values());
  }, [holdingNameOptions, marketSearchOptions]);

  const searchMarketStocks = async (keyword: string) => {
    const q = keyword.trim();
    if (!q) {
      setMarketSearchOptions([]);
      return;
    }
    setMarketSearching(true);
    try {
      const rows = await getApi().searchStocks({ keyword: q });
      setMarketSearchOptions(rows || []);
    } catch (_e) {
      setMarketSearchOptions([]);
    } finally {
      setMarketSearching(false);
    }
  };

  const getApi = () => {
    if (!window.api) {
      throw new Error("未检测到 Electron API，请使用一键启动.command 打开应用，而不是直接用浏览器访问。\n若已用一键启动，请重启应用后再试。");
    }
    return window.api;
  };

  const refresh = async () => {
    const api = getApi();
    const [s, t, sm, matches] = await Promise.all([api.getSettings(), api.listTrades(), api.getSummary(), api.listSellMatches()]);
    setSettings(s);
    setTrades(t);
    setSummary(sm);
    setSellMatches(matches);
    capitalForm.setFieldsValue({ initial_capital: s.initial_capital });
    aiForm.setFieldsValue({ active_ai_profile_id: s.active_ai_profile_id });
  };

  const bootstrapAuth = async () => {
    const api = getApi();
    const status = await api.authStatus();
    setPasswordEnabled(Boolean(status.enabled));
    setIsAuthenticated(!status.enabled || Boolean(status.authenticated));
    setAuthChecked(true);
    if (!status.enabled || status.authenticated) {
      await refresh();
      const rows = await api.listAIReports({});
      setReports(rows);
    }
  };

  const onSetupPassword = async () => {
    if (newPasswordInput.length < 6) throw new Error("密码至少 6 位");
    if (newPasswordInput !== newPasswordConfirm) throw new Error("两次输入的新密码不一致");
    setAuthLoading(true);
    try {
      await getApi().setupPassword({ password: newPasswordInput });
      setPasswordEnabled(true);
      setIsAuthenticated(true);
      setNewPasswordInput("");
      setNewPasswordConfirm("");
      await refresh();
      const rows = await getApi().listAIReports({});
      setReports(rows);
      message.success("主密码设置成功");
    } finally {
      setAuthLoading(false);
    }
  };

  const onSkipPasswordSetup = async () => {
    setAuthLoading(true);
    try {
      setPasswordEnabled(false);
      setIsAuthenticated(true);
      setNewPasswordInput("");
      setNewPasswordConfirm("");
      await refresh();
      const rows = await getApi().listAIReports({});
      setReports(rows);
      message.success("已跳过主密码设置，当前为免密码进入");
    } finally {
      setAuthLoading(false);
    }
  };

  const onLogin = async () => {
    if (!passwordInput) throw new Error("请输入密码");
    setAuthLoading(true);
    try {
      await getApi().login({ password: passwordInput });
      setIsAuthenticated(true);
      setPasswordInput("");
      await refresh();
      const rows = await getApi().listAIReports({});
      setReports(rows);
      message.success("解锁成功");
    } finally {
      setAuthLoading(false);
    }
  };

  const onLogout = async () => {
    await getApi().logout();
    setIsAuthenticated(false);
    setTrades([]);
    setSellMatches([]);
    setReports([]);
    setQuotes({});
    message.success("已锁定");
  };

  const onChangePassword = async () => {
    if (!changePwdOld) throw new Error("请输入旧密码");
    if (!changePwdNew && !changePwdConfirm) {
      await getApi().changePassword({ oldPassword: changePwdOld, newPassword: "" });
      setPasswordEnabled(false);
      setChangePwdOpen(false);
      setChangePwdOld("");
      setChangePwdNew("");
      setChangePwdConfirm("");
      message.success("已删除登录密码，后续可免密码进入");
      return;
    }
    if (!changePwdNew || !changePwdConfirm) throw new Error("请完整填写新密码和确认新密码，或都留空以删除密码");
    if (changePwdNew.length < 6) throw new Error("新密码至少 6 位");
    if (changePwdNew !== changePwdConfirm) throw new Error("两次输入的新密码不一致");
    await getApi().changePassword({ oldPassword: changePwdOld, newPassword: changePwdNew });
    setChangePwdOpen(false);
    setChangePwdOld("");
    setChangePwdNew("");
    setChangePwdConfirm("");
    message.success("主密码已更新");
  };

  useEffect(() => {
    bootstrapAuth().catch((e) => message.error(String(e)));
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(HOLDING_ORDER_KEY);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        setHoldingOrder(arr.map((x) => String(x)).filter(Boolean));
      }
    } catch (_e) {}
  }, []);

  useEffect(() => {
    const symbols = new Set((summary.holdings || []).map((h) => h.symbol));
    if (!symbols.size) {
      setHoldingOrder([]);
      return;
    }
    setHoldingOrder((prev) => {
      const keep = prev.filter((s) => symbols.has(s));
      const append = Array.from(symbols).filter((s) => !keep.includes(s));
      return [...keep, ...append];
    });
  }, [summary.holdings]);

  useEffect(() => {
    try {
      localStorage.setItem(HOLDING_ORDER_KEY, JSON.stringify(holdingOrder));
    } catch (_e) {}
  }, [holdingOrder]);

  useEffect(() => {
    const timer = setTimeout(() => {
      Object.keys(chartRefs.current).forEach((code) => {
        const el = chartRefs.current[code];
        if (!el) return;
        const inst = echarts.getInstanceByDom(el);
        inst?.resize();
      });
    }, 80);
    return () => clearTimeout(timer);
  }, [holdingOrder]);

  useEffect(() => {
    const holdings = summary.holdings || [];
    if (!holdings.length) return;
    let cancelled = false;

    const pollOnce = async () => {
      if (pollInFlightRef.current || cancelled) return;
      pollInFlightRef.current = true;
      try {
        const nextQuotes = await Promise.all(
          holdings.map(async (h) => {
            const period = periods[h.symbol] || "day";
            try {
              const q = await getApi().pollStock({ code: h.symbol, period });
              return [h.symbol, q] as const;
            } catch (_e) {
              return null;
            }
          })
        );
        if (cancelled) return;
        const merged = nextQuotes.filter((x): x is readonly [string, StockQuote] => Boolean(x));
        if (merged.length > 0) {
          setQuotes((s) => {
            const out = { ...s };
            merged.forEach(([symbol, q]) => {
              out[symbol] = q;
            });
            return out;
          });
        }
      } finally {
        pollInFlightRef.current = false;
      }
    };

    void pollOnce();
    const timer = setInterval(() => {
      void pollOnce();
    }, 15000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [summary.holdings, periods]);

  const switchPeriod = async (code: string, period: ChartPeriod) => {
    setPeriods((s) => ({ ...s, [code]: period }));
    const kline = await getApi().stockTimeline({ code, period });
    setQuotes((s) => ({
      ...s,
      [code]: {
        ...(s[code] || { code, name: code, price: 0, prevClose: 0, open: 0, high: 0, low: 0, volumeHands: 0, turnover: 0, mainNetInflow: 0, bidAsk: [], kline: [] }),
        kline,
      },
    }));
  };

  const searchForAnalysis = async () => {
    const keyword = analysisKeyword.trim();
    if (!keyword) return;
    const rows = await getApi().searchStocks({ keyword });
    setAnalysisTargets(rows);
  };

  const runF10Analysis = async (code: string, name?: string) => {
    setAnalysisLoading(true);
    setAnalysisText("");
    try {
      const result = await getApi().requestAIAnalysis({ code, name, analysisType: "f10" });
      setAnalysisMeta({ code: result.code, name: result.name, price: result.price });
      setAnalysisText(result.analysis || "");
    // Load all reports globally so old history is preserved and visible
    const list = await getApi().listAIReports({});
    setReports(list);
    message.success("AI 全解分析完成");
    } catch (e) {
      message.error(String(e));
    } finally {
      setAnalysisLoading(false);
    }
  };

  const runOrderbookAnalysis = async (code: string, name?: string) => {
    setAnalysisLoading(true);
    setAnalysisText("");
    try {
      const result = await getApi().requestAIAnalysis({ code, name, analysisType: "orderbook" });
      setAnalysisMeta({ code: result.code, name: result.name, price: result.price });
      setAnalysisText(result.analysis || "");
      const list = await getApi().listAIReports({});
      setReports(list);
      message.success("AI 盘口分析完成");
    } catch (e) {
      message.error(String(e));
    } finally {
      setAnalysisLoading(false);
    }
  };

  const runBothAnalysis = async (code: string, name?: string) => {
    setAnalysisLoading(true);
    setAnalysisText("");
    try {
      const [f10, orderbook] = await Promise.all([
        getApi().requestAIAnalysis({ code, name, analysisType: "f10" }),
        getApi().requestAIAnalysis({ code, name, analysisType: "orderbook" }),
      ]);
      setAnalysisMeta({ code: f10.code, name: f10.name, price: f10.price });
      setAnalysisText(`【全解分析】\n${f10.analysis || ""}\n\n【盘口分析】\n${orderbook.analysis || ""}`);
      const list = await getApi().listAIReports({});
      setReports(list);
      message.success("全解分析 + 盘口分析已完成");
    } catch (e) {
      message.error(String(e));
    } finally {
      setAnalysisLoading(false);
    }
  };

  const onDeleteReport = async (id: number) => {
    await getApi().deleteAIReport({ id });
    const list = await getApi().listAIReports({});
    setReports(list);
    message.success("报告已删除");
  };

  const onExportBackupJson = async () => {
    const res = await getApi().exportBackupJson();
    if (res?.canceled) return;
    if (res?.ok) {
      message.success(`备份导出成功：${res.filePath || "已保存"}`);
    }
  };

  const onImportBackupJson = async () => {
    const res = await getApi().importBackupJson({ mode: "merge", overwriteSecrets: true });
    if (res?.canceled) return;
    await refresh();
    message.success(`导入完成：交易新增 ${Number(res.importedTrades || 0)}，交易跳过 ${Number(res.skippedTrades || 0)}，报告新增 ${Number(res.importedReports || 0)}，报告跳过 ${Number(res.skippedReports || 0)}`);
  };

  const openReport = (r: AiReport) => {
    setAnalysisText(r.content || "");
    setAnalysisMeta({ code: r.code, name: r.name || r.code, price: 0 });
  };

  useEffect(() => {
    Object.entries(quotes).forEach(([code, q]) => {
      const el = chartRefs.current[code];
      if (!el || !q.kline?.length) return;
      const inst = echarts.getInstanceByDom(el) || echarts.init(el);
      const isTimeline = (periods[code] || "day") === "timeline";
      const volColors = q.kline.map((k) => (k.close >= k.open ? "#16a34a" : "#ef4444"));
      inst.setOption({
        animation: false,
        tooltip: {
          trigger: "axis",
          axisPointer: { type: "cross" },
          formatter: (params: Array<{ axisValue: string; data: number[] | number }>) => {
            if (!params?.length) return "";
            const p = params[0];
            const d = p.data as number[];
            if (Array.isArray(d) && d.length >= 4) {
              return `${p.axisValue}<br/>开: ${fmtMoney(d[0])} 收: ${fmtMoney(d[1])}<br/>低: ${fmtMoney(d[2])} 高: ${fmtMoney(d[3])}`;
            }
            return `${p.axisValue}<br/>价: ${fmtMoney(Number(p.data || 0))}`;
          },
        },
        grid: [
          { left: 48, right: 80, top: 10, height: "66%" },
          { left: 48, right: 80, top: "79%", height: "17%" },
        ],
        xAxis: [
          { type: "category", data: q.kline.map((k) => k.date), axisLabel: { show: false } },
          { type: "category", gridIndex: 1, data: q.kline.map((k) => k.date), axisLabel: { color: "#888", interval: "auto" } },
        ],
        yAxis: [
          { scale: true, splitLine: { lineStyle: { color: "#eee", type: "dashed" } } },
          { gridIndex: 1, scale: true, splitLine: { show: false }, axisLabel: { show: false } },
        ],
        series: [
          (isTimeline
            ? {
                type: "line",
                smooth: true,
                data: q.kline.map((k) => k.close),
                lineStyle: { color: "#2563eb", width: 2 },
                showSymbol: false,
              }
            : {
                type: "candlestick",
                data: q.kline.map((k) => [k.open, k.close, k.low, k.high]),
                itemStyle: { color: "#e53e3e", color0: "#16a34a", borderColor: "#e53e3e", borderColor0: "#16a34a" },
              }),
          {
            type: "bar",
            xAxisIndex: 1,
            yAxisIndex: 1,
            data: q.kline.map((k, i) => ({ value: k.volume, itemStyle: { color: volColors[i] } })),
            barWidth: "55%",
          },
        ],
      });
    });
  }, [quotes, periods]);

  const onCreateTrade = async (values: {
    trade_date: string;
    trade_time: string;
    symbol: string;
    security_name: string;
    trade_no?: string;
    side: Side;
    price: unknown;
    quantity: unknown;
  }) => {
    const api = getApi();
    const all = tradeForm.getFieldsValue(true) as {
      trade_date?: string;
      trade_time?: string;
      symbol?: string;
      security_name?: string;
      trade_no?: string;
      side?: Side;
      price?: unknown;
      quantity?: unknown;
    };
    const rawPrice = all.price ?? values.price ?? tradeForm.getFieldValue("price");
    const rawQty = all.quantity ?? values.quantity ?? tradeForm.getFieldValue("quantity");
    const normalizedPrice = toNum(rawPrice);
    const normalizedQty = toNum(rawQty);
    if (!Number.isFinite(normalizedPrice) || normalizedPrice <= 0) {
      throw new Error(`成交价格必须大于 0（当前值: ${String(rawPrice)}）`);
    }
    if (!Number.isFinite(normalizedQty) || normalizedQty <= 0) {
      throw new Error("成交数量必须大于 0");
    }

    const result = await api.createTrade({
      trade_date: String(all.trade_date || values.trade_date || ""),
      trade_time: String(all.trade_time || values.trade_time || ""),
      symbol: String(all.symbol || values.symbol || ""),
      security_name: String(all.security_name || values.security_name || ""),
      trade_no: String(all.trade_no || values.trade_no || "").trim(),
      side: (all.side || values.side || "BUY") as Side,
      price: normalizedPrice,
      quantity: Math.trunc(normalizedQty),
      source: "MANUAL",
    });
    if (result.skipped) message.success("检测到重复成交编号，已自动跳过");
    else message.success("交易记录已保存");
    tradeForm.resetFields();
    tradeForm.setFieldsValue(emptyTrade);
    await refresh();
  };

  const onSaveCapital = async () => {
    const api = getApi();
    const values = await capitalForm.validateFields();
    const next = await api.saveSettings({ ...settings, ...values });
    setSettings(next);
    message.success("本金已保存");
  };

  const onSaveAiSettings = async () => {
    const api = getApi();
    const values = await aiForm.validateFields();
    const next = await api.saveSettings({ ...settings, ...values });
    setSettings(next);
    message.success("AI 配置已保存");
  };

  const onAddAiProfile = async () => {
    const api = getApi();
    const values = await profileForm.validateFields();
    const id = values.id || `p_${Date.now()}`;
    const nextProfiles = [
      ...settings.ai_profiles.filter((p) => p.id !== id),
      { id, name: values.name, base_url: values.base_url, api_key: values.api_key, model: values.model },
    ];
    const active = settings.active_ai_profile_id || id;
    const next = await api.saveSettings({ ...settings, ai_profiles: nextProfiles, active_ai_profile_id: active });
    setSettings(next);
    aiForm.setFieldsValue({ active_ai_profile_id: next.active_ai_profile_id });
    profileForm.resetFields();
    message.success("模型配置已保存");
  };

  const onDeleteAiProfile = async (id: string) => {
    const api = getApi();
    const nextProfiles = settings.ai_profiles.filter((p) => p.id !== id);
    const nextActive = settings.active_ai_profile_id === id ? (nextProfiles[0]?.id || "") : settings.active_ai_profile_id;
    const next = await api.saveSettings({ ...settings, ai_profiles: nextProfiles, active_ai_profile_id: nextActive });
    setSettings(next);
    aiForm.setFieldsValue({ active_ai_profile_id: next.active_ai_profile_id });
    message.success("模型配置已删除");
  };

  const uploadProps: UploadProps = {
    accept: "image/*",
    showUploadList: false,
    beforeUpload: async (file) => {
      const reader = new FileReader();
      setUploading(true);
      reader.onload = async () => {
        try {
          const imageData = String(reader.result);
          const raw = await getApi().extractFromImage({ imageData });
          const rows = normalizeAiExtractRows(raw);
          setAiRows(rows);
          message.success(`识别完成，共 ${rows.length} 条`);
        } catch (e) {
          message.error(aiErrorMessage(e));
        } finally {
          setUploading(false);
        }
      };
      reader.readAsDataURL(file);
      return false;
    },
  };

  const fileUploadProps: UploadProps = {
    accept: ".xls,.xlsx,.csv",
    showUploadList: false,
    beforeUpload: async (file) => {
      setFileUploading(true);
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const dataUrl = String(reader.result || "");
          const base64Data = dataUrl.split(",")[1] || "";
          const raw = await getApi().extractFromFile({ fileName: file.name, base64Data });
          const rows = normalizeAiExtractRows(raw);
          setAiRows(rows);
          message.success(`文件识别完成，共 ${rows.length} 条`);
        } catch (e) {
          message.error(aiErrorMessage(e));
        } finally {
          setFileUploading(false);
        }
      };
      reader.readAsDataURL(file);
      return false;
    },
  };

  useEffect(() => {
    const onPaste = async (evt: ClipboardEvent) => {
      const items = evt.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (!item.type.startsWith("image/")) continue;
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        setUploading(true);
        reader.onload = async () => {
          try {
            const imageData = String(reader.result);
            const raw = await getApi().extractFromImage({ imageData });
            const rows = normalizeAiExtractRows(raw);
            setAiRows(rows);
            message.success(`粘贴识别完成，共 ${rows.length} 条`);
          } catch (e) {
            message.error(aiErrorMessage(e));
          } finally {
            setUploading(false);
          }
        };
        reader.readAsDataURL(file);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const onImportAiRows = async () => {
    const res = await getApi().createTradesBulk({ rows: aiRows.map((row) => ({ ...row, source: "AI" })) });
    setAiRows([]);
    const skipped = Number(res.skipped || 0);
    message.success(`AI 识别结果已入库：成功 ${res.inserted} 条，重复编号跳过 ${skipped} 条`);
    await refresh();
  };

  const canImport = useMemo(() => aiRows.length > 0, [aiRows.length]);

  const filteredTrades = useMemo(() => {
    return trades.filter((t) => {
      if (filters.date && t.trade_date !== filters.date) return false;
      if (filters.symbol && t.symbol !== filters.symbol.trim()) return false;
      if (filters.name && t.security_name !== filters.name.trim()) return false;
      if (filters.side && t.side !== filters.side) return false;
      if (filters.deducted) {
        if (t.side !== "BUY") return false;
        const deducted = Number(t.matched_qty || 0) > 0 ? "YES" : "NO";
        if (deducted !== filters.deducted) return false;
      }
      return true;
    });
  }, [trades, filters]);

  const openEdit = (trade: Trade) => {
    setEditingTrade(trade);
    editForm.setFieldsValue({
      id: trade.id,
      trade_date: trade.trade_date,
      trade_time: trade.trade_time,
      symbol: trade.symbol,
      security_name: trade.security_name,
      trade_no: trade.trade_no || "",
      side: trade.side,
      price: trade.price,
      quantity: trade.quantity,
    });
  };

  const onSaveEdit = async () => {
    const api = getApi();
    const values = await editForm.validateFields();
    await api.updateTrade(values);
    message.success("交易记录已更新");
    setEditingTrade(null);
    await refresh();
  };

  const onDeleteTrade = async () => {
    if (!editingTrade) return;
    await getApi().deleteTrade({ id: editingTrade.id });
    message.success("交易记录已删除");
    setEditingTrade(null);
    await refresh();
  };

  const confirmPhrase = "我确定清除所有交易记录";
  const canConfirmClear = clearConfirmText.trim() === confirmPhrase;

  const onClearAllTrades = async () => {
    if (!canConfirmClear) return;
    setClearingTrades(true);
    try {
      const res = await getApi().clearAllTrades({ confirmText: clearConfirmText.trim() });
      setClearModalOpen(false);
      setClearConfirmText("");
      await refresh();
      message.success(`已清除交易记录 ${res.deletedTrades} 条，配对明细 ${res.deletedMatches} 条，并已清空AI设置`);
    } finally {
      setClearingTrades(false);
    }
  };

  useEffect(() => {
    setCostSellPrices((prev) => {
      const next: Record<number, number> = {};
      for (const row of summary.costTrades || []) {
        const existing = prev[row.trade_id];
        next[row.trade_id] = Number.isFinite(existing) && existing > 0 ? existing : Number(row.breakeven_sell_price || 0);
      }
      return next;
    });
  }, [summary.costTrades]);

  const calcCostTradeNetPnl = (row: CostTrade, sellPriceInput?: number) => {
    const sellPrice = Number(sellPriceInput || 0);
    const qty = Number(row.remaining_qty || 0);
    if (!Number.isFinite(sellPrice) || sellPrice <= 0 || !Number.isFinite(qty) || qty <= 0) return 0;
    const sellAmount = sellPrice * qty;
    const sellFee = round2(5 + round2(sellAmount * 0.0005));
    const buyAmount = Number(row.buy_price || 0) * qty;
    const buyFee = Number(row.buy_fee || 0);
    return round2(sellAmount - buyAmount - buyFee - sellFee);
  };

  const unrealizedPnl = useMemo(() => {
    const holdings = summary.holdings || [];
    return round2(
      holdings.reduce((acc, h) => {
        const q = quotes[h.symbol];
        if (!q || !Number.isFinite(q.price)) return acc;
        const marketValue = Number(q.price) * Number(h.quantity || 0);
        return acc + (marketValue - Number(h.total_value || 0));
      }, 0)
    );
  }, [summary.holdings, quotes]);

  const totalPnlWithUnrealized = useMemo(() => {
    return round2(Number(summary.realizedPnl || 0) + unrealizedPnl);
  }, [summary.realizedPnl, unrealizedPnl]);

  const costNameOptions = useMemo(() => {
    return (summary.holdings || []).map((h) => h.security_name).filter(Boolean).sort((a, b) => a.localeCompare(b, "zh-CN"));
  }, [summary.holdings]);

  const costNameCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const row of summary.costTrades || []) {
      const key = String(row.security_name || "");
      if (!key) continue;
      m.set(key, (m.get(key) || 0) + 1);
    }
    return m;
  }, [summary.costTrades]);

  const filteredCostTrades = useMemo(() => {
    const name = String(selectedHoldingName || "").trim();
    if (!name) return summary.costTrades || [];
    return (summary.costTrades || []).filter((r) => String(r.security_name || "") === name);
  }, [summary.costTrades, selectedHoldingName]);

  const sortedCostTrades = useMemo(() => {
    const rows = [...filteredCostTrades];
    rows.sort((a, b) => {
      if (a.buy_price !== b.buy_price) return costPriceSort === "asc" ? a.buy_price - b.buy_price : b.buy_price - a.buy_price;
      return b.trade_id - a.trade_id;
    });
    return rows;
  }, [filteredCostTrades, costPriceSort]);

  const settingsMenuItems = [
    {
      key: "lock-app",
      label: "立即锁定",
      onClick: () => onLogout().catch((e) => message.error(errText(e))),
    },
    {
      key: "change-password",
      label: "修改主密码",
      onClick: () => setChangePwdOpen(true),
    },
    {
      key: "backup-export",
      label: "数据备份(JSON)",
      onClick: () => onExportBackupJson().catch((e) => message.error(errText(e))),
    },
    {
      key: "backup-import",
      label: "数据导入(JSON)",
      onClick: () => onImportBackupJson().catch((e) => message.error(errText(e))),
    },
    {
      key: "capital-settings",
      label: "本金设置",
      onClick: () => setCapitalModalOpen(true),
    },
    {
      key: "ai-settings",
      label: "AI模型设置",
      onClick: () => setAiSettingsModalOpen(true),
    },
    {
      key: "clear-trades",
      label: <span style={{ color: "#c53030" }}>清除所有交易记录</span>,
      onClick: () => setClearModalOpen(true),
    },
  ];

  if (!authChecked) {
    return (
      <div className="page">
        <Card title="正在检查访问权限" style={{ maxWidth: 520, margin: "8vh auto 0" }}>
          <Typography.Text type="secondary">请稍候...</Typography.Text>
        </Card>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="page">
        <Card title={passwordEnabled ? "输入主密码解锁" : "首次设置主密码"} style={{ maxWidth: 520, margin: "8vh auto 0" }}>
          <Space direction="vertical" className="full-width" size={14}>
            {passwordEnabled ? (
              <>
                <Input.Password
                  placeholder="输入主密码"
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  onPressEnter={() => onLogin().catch((e) => message.error(errText(e)))}
                />
                <Button type="primary" loading={authLoading} onClick={() => onLogin().catch((e) => message.error(errText(e)))}>
                  解锁
                </Button>
                <Alert
                  type="warning"
                  showIcon
                  message="忘记密码重置"
                  description="保留交易数据的前提下，可在宿主机数据目录对应的 SQLite 中清空 app_password_hash、app_password_salt 并将 app_lock_enabled 设为0。"
                />
              </>
            ) : (
              <>
                <Input.Password placeholder="设置主密码（至少6位）" value={newPasswordInput} onChange={(e) => setNewPasswordInput(e.target.value)} />
                <Input.Password placeholder="再次输入主密码" value={newPasswordConfirm} onChange={(e) => setNewPasswordConfirm(e.target.value)} />
                <Button type="primary" loading={authLoading} onClick={() => onSetupPassword().catch((e) => message.error(errText(e)))}>
                  确认设置并进入
                </Button>
                <Button loading={authLoading} onClick={() => onSkipPasswordSetup().catch((e) => message.error(errText(e)))}>
                  免密码进入
                </Button>
              </>
            )}
          </Space>
        </Card>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <Typography.Title level={2} className="page-title">股票交易历史本地管理</Typography.Title>
        <Dropdown menu={{ items: settingsMenuItems }} trigger={["click"]}>
          <Button>设置</Button>
        </Dropdown>
      </div>

      <Row gutter={16} className="summary-row">
        <Col xs={24} sm={12} lg={4}><Card><Statistic title="起始本金" value={summary.initialCapital} precision={2} /></Card></Col>
        <Col xs={24} sm={12} lg={5}><Card><Statistic title="已实现盈亏" value={summary.realizedPnl} precision={2} valueStyle={{ color: summary.realizedPnl >= 0 ? "#2f855a" : "#c53030" }} /></Card></Col>
        <Col xs={24} sm={12} lg={5}><Card><Statistic title="未实现盈亏" value={unrealizedPnl} precision={2} valueStyle={{ color: unrealizedPnl >= 0 ? "#2f855a" : "#c53030" }} /></Card></Col>
        <Col xs={24} sm={12} lg={5}><Card><Statistic title="累计手续费" value={summary.totalFees} precision={2} /></Card></Col>
        <Col xs={24} sm={24} lg={5}><Card><Statistic title="总盈亏（含持仓）" value={totalPnlWithUnrealized} precision={2} valueStyle={{ color: totalPnlWithUnrealized >= 0 ? "#2f855a" : "#c53030" }} /></Card></Col>
      </Row>

       <Card title="当前持仓（按买入成本）" className="section-card">
         <Table<HoldingItem>
           rowKey="symbol"
           pagination={false}
           dataSource={summary.holdings}
           columns={[
             { title: "股票代码", dataIndex: "symbol" },
             { title: "股票名称", dataIndex: "security_name" },
             { title: "数量", dataIndex: "quantity" },
              { title: "总市值(成本)", dataIndex: "total_value", render: (v: number) => fmtMoney(v), responsive: ["md"] },
             {
                title: "现价",
                render: (_: unknown, h: { symbol: string }) => {
                  const q = quotes[h.symbol];
                  return q && Number.isFinite(q.price) ? fmtMoney(q.price) : "--";
                },
                responsive: ["sm"],
              },
              {
                title: "参考市值",
                render: (_: unknown, h: { symbol: string; quantity: number }) => {
                  const q = quotes[h.symbol];
                  return q && Number.isFinite(q.price) ? fmtMoney(q.price * h.quantity) : "--";
                },
                responsive: ["lg"],
              },
              {
                title: "最低未抵扣买入 (至少2笔)",
                width: 180,
                render: (_: unknown, h: HoldingItem) => {
                  const unmatchedBuys = h.unmatchedBuys || [];
                  if (unmatchedBuys.length === 0) return "无";
                  // Format: price(qty), price(qty)
                  return (
                    <span className="holding-unmatched">
                      {unmatchedBuys.map((b, i) => {
                        return <span key={i}>{fmtMoney(b.price)} ({b.quantity}){i < unmatchedBuys.length - 1 ? <br/> : ""}</span>;
                      })}
                    </span>
                  );
                },
                responsive: ["md"],
              },
            ]}
            scroll={{ x: "max-content" }}
            locale={{ emptyText: "暂无持仓" }}
          />
        </Card>

       <Card
          title="成本利润计算"
          className="section-card cost-card"
         extra={
           <Button size="small" onClick={() => setCostPriceSort((s) => (s === "asc" ? "desc" : "asc"))}>
             买入价：{costPriceSort === "asc" ? "从小到大" : "从大到小"}
           </Button>
         }
       >
         <Space className="filter-toolbar" wrap style={{ marginBottom: 12 }}>
           <Button size="small" type={selectedHoldingName ? "default" : "primary"} onClick={() => setSelectedHoldingName("")}>全部 ({(summary.costTrades || []).length})</Button>
           {costNameOptions.map((name) => (
             <Button
               key={name}
               size="small"
               type={selectedHoldingName === name ? "primary" : "default"}
               onClick={() => setSelectedHoldingName(name)}
             >
               {name} ({costNameCounts.get(name) || 0})
             </Button>
           ))}
         </Space>
         <Table<CostTrade>
            rowKey="trade_id"
            pagination={{ pageSize: 10 }}
            dataSource={sortedCostTrades}
            columns={[
              { title: "买入日期", dataIndex: "trade_date" },
              { title: "买入时间", dataIndex: "trade_time", responsive: ["md"] },
              { title: "代码", dataIndex: "symbol" },
              { title: "名称", dataIndex: "security_name" },
              { title: "买入成交编号", dataIndex: "trade_no", render: (v: string) => v || "-", responsive: ["lg"] },
              { title: "买入价", dataIndex: "buy_price", render: (v: number) => fmtMoney(v) },
              { title: "未抵扣数量", dataIndex: "remaining_qty" },
              { title: "保本卖价", dataIndex: "breakeven_sell_price", render: (v: number) => fmtMoney(v) },
             {
               title: "卖出价格",
               render: (_v: unknown, r: CostTrade) => (
                 <InputNumber
                   min={0}
                   step={0.01}
                   precision={2}
                   value={costSellPrices[r.trade_id]}
                   onChange={(v) => {
                     const n = typeof v === "number" ? v : Number(v || 0);
                     setCostSellPrices((s) => ({ ...s, [r.trade_id]: Number.isFinite(n) ? n : 0 }));
                   }}
                 />
               ),
             },
             {
               title: "净盈亏",
               render: (_v: unknown, r: CostTrade) => {
                 const pnl = calcCostTradeNetPnl(r, costSellPrices[r.trade_id]);
                 const color = pnl >= 0 ? "#2f855a" : "#c53030";
                 return <span style={{ color }}>{fmtMoney(pnl)}</span>;
                },
             },
            ]}
            scroll={{ x: "max-content" }}
            locale={{ emptyText: "暂无未抵扣成本条目" }}
          />
        </Card>

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: "list",
            label: "交易明细",
            children: (
              <Card className="module-card trade-list-card">
                <Space className="filter-toolbar" wrap>
                  <DatePicker placeholder="筛选日期" onChange={(_, ds) => setFilters((s) => ({ ...s, date: ds || "" }))} />
                  <Select
                    showSearch
                    allowClear
                    placeholder="筛选代码"
                    className="filter-control filter-control-sm"
                    options={holdingSymbolOptions}
                    onChange={(v) => setFilters((s) => ({ ...s, symbol: String(v || "") }))}
                  />
                  <Select
                    showSearch
                    allowClear
                    placeholder="筛选名称"
                    className="filter-control filter-control-md"
                    options={holdingNameOptions}
                    onChange={(v) => setFilters((s) => ({ ...s, name: String(v || "") }))}
                  />
                  <Select allowClear placeholder="筛选买卖" className="filter-control filter-control-xs" options={[{ label: "买入", value: "BUY" }, { label: "卖出", value: "SELL" }]} onChange={(v) => setFilters((s) => ({ ...s, side: v || "" }))} />
                  <Select
                    allowClear
                    placeholder="已抵扣是否"
                    className="filter-control filter-control-sm"
                    options={[{ label: "是", value: "YES" }, { label: "否", value: "NO" }]}
                    onChange={(v) => setFilters((s) => ({ ...s, deducted: v || "" }))}
                  />
                </Space>
                <Table<Trade> rowKey="id" dataSource={filteredTrades} scroll={{ x: "max-content" }} columns={[
                  { title: "日期", dataIndex: "trade_date" },
                  { title: "时间", dataIndex: "trade_time", responsive: ["md"] },
                  { title: "代码", dataIndex: "symbol" },
                  { title: "名称", dataIndex: "security_name" },
                  { title: "成交编号", dataIndex: "trade_no", render: (v: string) => v || "-", responsive: ["lg"] },
                  { title: "买卖", dataIndex: "side", render: (v: Side) => <Tag color={v === "BUY" ? "blue" : "volcano"}>{v === "BUY" ? "买入" : "卖出"}</Tag> },
                  { title: "价格", dataIndex: "price", render: (v: number) => fmtMoney(v) },
                  { title: "数量", dataIndex: "quantity" },
                  { title: "成交金额", dataIndex: "amount", render: (v: number) => fmtMoney(v), responsive: ["md"] },
                  {
                    title: "未抵扣数量",
                    responsive: ["lg"],
                    render: (_v: unknown, r: Trade) => {
                      if (r.side !== "BUY") return "-";
                      const remaining = Number(r.quantity || 0) - Number(r.matched_qty || 0);
                      return remaining > 0 ? remaining : 0;
                    },
                  },
                  {
                    title: "已抵扣",
                    responsive: ["lg"],
                    render: (_v: unknown, r: Trade) => {
                      if (r.side !== "BUY") return "-";
                      const remaining = Number(r.quantity || 0) - Number(r.matched_qty || 0);
                      return remaining <= 0 ? "是" : "否";
                    },
                  },
                  { title: "手续费", dataIndex: "fee", render: (v: number) => fmtMoney(v), responsive: ["lg"] },
                  { title: "操作", render: (_v: unknown, r: Trade) => <Button size="small" onClick={() => openEdit(r)}>编辑</Button> },
                ]} />

                <Card title="持仓股票行情与K线" className="section-card module-card">
                      <div className="quote-grid">
                    {orderedHoldings.map((h) => {
                      const q = quotes[h.symbol];
                      const rise = q ? q.price - q.prevClose : 0;
                      const risePct = q && q.prevClose ? (rise / q.prevClose) * 100 : 0;
                      return (
                        <div
                          key={h.symbol}
                          className={`quote-sortable-item ${draggingSymbol === h.symbol ? "is-dragging" : ""}`}
                          draggable
                          onDragStart={() => onHoldingDragStart(h.symbol)}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={() => onHoldingDrop(h.symbol)}
                          onDragEnd={onHoldingDragEnd}
                        >
                        <Card size="small" className="quote-card" bodyStyle={{ padding: 0 }}>
                          <div className="quote-header">
                            <Space align="end" size={16}>
                              <div>
                                <Typography.Title level={3} className="quote-name">{h.security_name}</Typography.Title>
                                <Typography.Text type="secondary" className="quote-symbol">{h.symbol}</Typography.Text>
                              </div>
                              <div className={`quote-price ${rise >= 0 ? "quote-up" : "quote-down"}`}>{q ? fmtMoney(q.price) : "--"}</div>
                              <div className={`quote-change ${rise >= 0 ? "quote-up" : "quote-down"}`}>
                                {q ? `${fmtMoney(rise)} (${risePct.toFixed(2)}%)` : "--"}
                              </div>
                            </Space>
                          </div>

                          <Row className="quote-metrics-row">
                            {[
                              ["均价", q ? ((q.open + q.high + q.low + q.price) / 4) : 0],
                              ["今开", q?.open || 0],
                              ["最高", q?.high || 0],
                              ["最低", q?.low || 0],
                              ["量/换", q ? `${q.volumeHands.toFixed(2)}手/${q.turnover.toFixed(2)}%` : "--"],
                              ["主力净额", q ? fmtMoney(q.mainNetInflow) : "--"],
                            ].map(([k, v]) => (
                              <Col key={String(k)} xs={8} sm={8} md={4}>
                                <div className="quote-metric-label">{k}</div>
                                <div className="quote-metric-value">{typeof v === "number" ? fmtMoney(v) : v}</div>
                              </Col>
                            ))}
                          </Row>

                          <Row>
                            <Col xs={24} lg={17} className="quote-chart-col">
                              <div className="quote-period-switch">
                                <Space size={8}>
                                  <Button size="small" type={(periods[h.symbol] || "day") === "timeline" ? "primary" : "default"} onClick={() => switchPeriod(h.symbol, "timeline").catch((e) => message.error(String(e)))}>分时</Button>
                                  <Button size="small" type={(periods[h.symbol] || "day") === "day" ? "primary" : "default"} onClick={() => switchPeriod(h.symbol, "day").catch((e) => message.error(String(e)))}>日K</Button>
                                  <Button size="small" type={(periods[h.symbol] || "day") === "week" ? "primary" : "default"} onClick={() => switchPeriod(h.symbol, "week").catch((e) => message.error(String(e)))}>周K</Button>
                                </Space>
                              </div>
                              <div ref={(el) => { chartRefs.current[h.symbol] = el; }} className="quote-chart" />
                            </Col>
                            <Col xs={24} lg={7} className="quote-orderbook-col">
                              <Table<{ side: string; price: number; vol: number }>
                                size="small"
                                pagination={false}
                                rowKey={(_r, i) => `lv-${i}`}
                                dataSource={q ? [...q.bidAsk].reverse().map((r) => ({ side: `卖${r.level}`, price: r.askPrice, vol: r.askVol })).concat(q.bidAsk.map((r) => ({ side: `买${r.level}`, price: r.bidPrice, vol: r.bidVol }))) : []}
                                columns={[
                                  { title: "档位", dataIndex: "side" },
                                  { title: "价格", dataIndex: "price", render: (v: number) => (v ? <span className="orderbook-price">{fmtMoney(v)}</span> : "--") },
                                  { title: "量", dataIndex: "vol" },
                                ]}
                                scroll={{ x: "max-content" }}
                              />
                              <Button block className="quote-latest-btn" disabled>最新成交</Button>
                            </Col>
                          </Row>
                        </Card>
                        </div>
                      );
                    })}
                      </div>
                </Card>
              </Card>
            ),
          },
          {
            key: "trade",
            label: "交易录入",
            children: (
              <Row gutter={16}>
                <Col xs={24} lg={10}>
                  <Card title="手动录入">
                    <Form
                      form={tradeForm}
                      layout="vertical"
                      initialValues={emptyTrade}
                      validateMessages={{ required: "请填写${label}" }}
                      onFinish={(vals) => onCreateTrade(vals as { trade_date: string; trade_time: string; symbol: string; security_name: string; trade_no?: string; side: Side; price: number; quantity: number }).catch((e) => message.error(errText(e)))}
                    >
                      <Form.Item
                        name="trade_date"
                        label="成交日期"
                        rules={[{ required: true }]}
                        getValueProps={(v: string) => ({ value: v ? dayjs(v, "YYYY-MM-DD") : null })}
                        normalize={(v: Dayjs | null) => (v ? v.format("YYYY-MM-DD") : "")}
                      >
                        <DatePicker
                          style={{ width: "100%" }}
                          format="YYYY-MM-DD"
                          placeholder="请选择日期"
                        />
                      </Form.Item>
                      <Form.Item
                        name="trade_time"
                        label="成交时间"
                        rules={[{ required: true }]}
                        getValueProps={(v: string) => ({ value: v ? dayjs(v, "HH:mm:ss") : null })}
                        normalize={(v: Dayjs | null) => (v ? v.format("HH:mm:ss") : "")}
                      >
                        <TimePicker style={{ width: "100%" }} format="HH:mm:ss" placeholder="请选择时间（24小时制）" />
                      </Form.Item>
                      <Form.Item name="symbol" label="证券代码" rules={[{ required: true }]}>
                        <Select
                          showSearch
                          allowClear
                          placeholder="选择或输入证券代码"
                          filterOption={false}
                          notFoundContent={marketSearching ? "搜索中..." : "无匹配，可继续输入"}
                          options={mergedSymbolOptions}
                          onSearch={(v) => searchMarketStocks(v).catch(() => {})}
                          onChange={(v) => {
                            const selectedCode = String(v || "");
                            const fromMarket = marketSearchOptions.find((x) => x.code === selectedCode);
                            const name = fromMarket?.name || holdingMapBySymbol.get(selectedCode);
                            if (name) tradeForm.setFieldValue("security_name", name);
                          }}
                        />
                      </Form.Item>
                      <Form.Item name="security_name" label="证券名称" rules={[{ required: true }]}>
                        <Select
                          showSearch
                          allowClear
                          placeholder="选择或输入证券名称"
                          filterOption={false}
                          notFoundContent={marketSearching ? "搜索中..." : "无匹配，可继续输入"}
                          options={mergedNameOptions}
                          onSearch={(v) => searchMarketStocks(v).catch(() => {})}
                          onChange={(v) => {
                            const selectedName = String(v || "");
                            const fromMarket = marketSearchOptions.find((x) => x.name === selectedName);
                            const code = fromMarket?.code || holdingMapByName.get(selectedName);
                            if (code) tradeForm.setFieldValue("symbol", code);
                          }}
                        />
                      </Form.Item>
                      <Form.Item name="trade_no" label="成交编号">
                        <Input placeholder="可选，若重复将自动跳过" />
                      </Form.Item>
                      <Form.Item name="side" label="买卖标志" rules={[{ required: true }]}> <Select options={[{ label: "证券买入", value: "BUY" }, { label: "证券卖出", value: "SELL" }]} /> </Form.Item>
                      <Form.Item name="price" label="成交价格" rules={[{ required: true }]}>
                        <Input inputMode="decimal" placeholder="例如 39.50" />
                      </Form.Item>
                      <Form.Item name="quantity" label="成交数量" rules={[{ required: true }]}>
                        <Input inputMode="numeric" placeholder="例如 200" />
                      </Form.Item>
                      <Button type="primary" htmlType="submit" block>保存记录</Button>
                    </Form>
                  </Card>
                </Col>
                <Col xs={24} lg={14}>
                  <Card title="AI 识别导入">
                    <Space direction="vertical" className="full-width">
                      <Alert type="info" showIcon message="支持粘贴截图、上传截图、上传xls/xlsx/csv文件识别。识别后可确认入库。" />
                      <Space>
                        <Upload {...uploadProps}><Button loading={uploading}>上传截图识别</Button></Upload>
                        <Upload {...fileUploadProps}><Button loading={fileUploading}>上传文件识别</Button></Upload>
                      </Space>
                      <Table<AiRow>
                        rowKey={(_r, i) => String(i)}
                        dataSource={aiRows}
                        pagination={false}
                        size="small"
                        columns={[
                          { title: "日期", dataIndex: "trade_date" },
                          { title: "时间", dataIndex: "trade_time", responsive: ["md"] },
                          { title: "代码", dataIndex: "symbol" },
                          { title: "名称", dataIndex: "security_name" },
                          { title: "成交编号", dataIndex: "trade_no", render: (v: string) => v || "", responsive: ["lg"] },
                          { title: "方向", dataIndex: "side" },
                          { title: "价格", dataIndex: "price" },
                          { title: "数量", dataIndex: "quantity" },
                          { title: "成交金额", dataIndex: "amount", render: (v: number) => (v ? fmtMoney(v) : ""), responsive: ["md"] },
                        ]}
                        scroll={{ x: "max-content" }}
                      />
                      <Button type="primary" disabled={!canImport} onClick={() => onImportAiRows().catch((e) => message.error(String(e)))}>确认入库</Button>
                    </Space>
                  </Card>
                </Col>
              </Row>
            ),
          },
          {
            key: "analysis",
            label: "股票分析",
            children: (
              <Card title="AI 全解分析（F10）">
                <Space className="analysis-toolbar" wrap>
                  <Input
                    placeholder="输入股票代码或名称"
                    className="analysis-search-input"
                    value={analysisKeyword}
                    onChange={(e) => setAnalysisKeyword(e.target.value)}
                    onPressEnter={() => searchForAnalysis().catch((e) => message.error(String(e)))}
                  />
                  <Button onClick={() => searchForAnalysis().catch((e) => message.error(String(e)))}>搜索</Button>
                </Space>

                <Table<StockSearchItem>
                  rowKey="code"
                  pagination={false}
                  dataSource={analysisTargets}
                  columns={[
                    { title: "代码", dataIndex: "code" },
                    { title: "名称", dataIndex: "name" },
                    { title: "市场", dataIndex: "market", responsive: ["md"] },
                    {
                      title: "操作",
                      render: (_: unknown, r: StockSearchItem) => (
                        <Space>
                          <Button type="primary" loading={analysisLoading} onClick={() => runF10Analysis(r.code, r.name)}>全解分析</Button>
                          <Button loading={analysisLoading} onClick={() => runOrderbookAnalysis(r.code, r.name)}>盘口分析</Button>
                          <Button loading={analysisLoading} onClick={() => runBothAnalysis(r.code, r.name)}>同时分析</Button>
                        </Space>
                      ),
                    },
                  ]}
                  scroll={{ x: "max-content" }}
                />

                <Card size="small" title="分析报告" className="subsection-card">
                  {analysisMeta ? (
                    <div className="analysis-meta">
                      标的：{analysisMeta.name}（{analysisMeta.code}） 现价：{analysisMeta.price > 0 ? fmtMoney(analysisMeta.price) : "--"}
                    </div>
                  ) : null}
                  <div className="analysis-content">
                    {analysisLoading ? "AI 正在分析，请稍候..." : analysisText || "请先搜索股票并点击“全解分析”"}
                  </div>
                </Card>

                <Card size="small" title="历史报告" className="subsection-card">
                  <Table<AiReport>
                    className="report-table"
                    rowKey="id"
                    pagination={{ pageSize: 6 }}
                    dataSource={reports}
                    columns={[
                      { title: "时间", dataIndex: "created_at", render: (v: string) => fmtLocalReportTime(v), responsive: ["md"] },
                      { title: "类型", dataIndex: "analysis_type", render: (v: string) => (v === "f10" ? "全解分析" : "盘口分析"), responsive: ["sm"] },
                      { title: "股票", render: (_: unknown, r: AiReport) => `${r.name || ""}(${r.code})` },
                      {
                        title: "查看",
                        render: (_: unknown, r: AiReport) => (
                          <Space>
                            <Button size="small" type={analysisMeta?.code === r.code && analysisText === r.content ? "primary" : "default"} onClick={() => openReport(r)}>打开</Button>
                            <Button danger size="small" onClick={() => onDeleteReport(r.id).catch((e) => message.error(String(e)))}>删除</Button>
                          </Space>
                        ),
                      },
                    ]}
                    scroll={{ x: "max-content" }}
                  />
                </Card>
              </Card>
            ),
          },
          {
            key: "matches",
            label: "卖出配对明细",
            children: (
              <Card title="最低买价优先配对明细">
                <Table<SellMatch>
                  rowKey="id"
                  dataSource={sellMatches}
                  columns={[
                    { title: "卖出日期", dataIndex: "sell_trade_date" },
                    { title: "卖出时间", dataIndex: "sell_trade_time", responsive: ["md"] },
                    { title: "卖出成交编号", dataIndex: "sell_trade_no", render: (v: string) => v || "-", responsive: ["lg"] },
                    { title: "代码", dataIndex: "symbol" },
                    { title: "名称", dataIndex: "security_name" },
                    { title: "买入成交编号", dataIndex: "buy_trade_no", render: (v: string) => v || "-", responsive: ["lg"] },
                    { title: "买入价", dataIndex: "buy_price", render: (v: number) => fmtMoney(v) },
                    { title: "卖出价", dataIndex: "sell_price", render: (v: number) => fmtMoney(v) },
                    { title: "配对数量", dataIndex: "matched_qty" },
                    { title: "毛利润", dataIndex: "gross_profit", render: (v: number) => fmtMoney(v), responsive: ["md"] },
                    { title: "分摊手续费", dataIndex: "allocated_fee", render: (v: number) => fmtMoney(v), responsive: ["lg"] },
                    { title: "净利润", dataIndex: "net_profit", render: (v: number) => <span className={v >= 0 ? "profit-up" : "profit-down"}>{v.toFixed(2)}</span> },
                  ]}
                  scroll={{ x: "max-content" }}
                />
              </Card>
            ),
          },
        ]}
      />

      <Modal
        title="本金设置"
        open={capitalModalOpen}
        onCancel={() => setCapitalModalOpen(false)}
        footer={null}
        width={560}
      >
        <Card title="起始本金设置">
          <Form form={capitalForm} layout="vertical" initialValues={settings}>
            <Form.Item name="initial_capital" label="起始本金" rules={[{ required: true }]}><InputNumber min={0} style={{ width: "100%" }} /></Form.Item>
            <Button
              type="primary"
              onClick={() =>
                onSaveCapital()
                  .then(() => setCapitalModalOpen(false))
                  .catch((e) => message.error(String(e)))
              }
            >
              保存本金
            </Button>
          </Form>
        </Card>
      </Modal>

      <Modal
        title="AI模型设置"
        open={aiSettingsModalOpen}
        onCancel={() => setAiSettingsModalOpen(false)}
        footer={null}
        width={900}
      >
        <Card title="AI 接口配置">
          <Form form={aiForm} layout="vertical" initialValues={settings}>
            <Form.Item name="active_ai_profile_id" label="当前使用模型">
              <Select
                placeholder="选择使用的模型"
                options={settings.ai_profiles.map((p) => ({ label: `${p.name} (${p.model})`, value: p.id }))}
              />
            </Form.Item>
            <Button type="primary" onClick={() => onSaveAiSettings().catch((e) => message.error(String(e)))}>保存当前模型选择</Button>
          </Form>

          <Card size="small" title="新增/更新模型" className="subsection-card">
            <Form form={profileForm} layout="vertical">
              <Form.Item name="id" label="模型ID（留空自动生成）"><Input /></Form.Item>
              <Form.Item name="name" label="模型名称" rules={[{ required: true }]}><Input placeholder="如：通义-主模型" /></Form.Item>
              <Form.Item name="base_url" label="Base URL" rules={[{ required: true }]}><Input /></Form.Item>
              <Form.Item name="api_key" label="API Key" rules={[{ required: true }]}><Input.Password /></Form.Item>
              <Form.Item name="model" label="Model" rules={[{ required: true }]}><Input /></Form.Item>
              <Button type="primary" onClick={() => onAddAiProfile().catch((e) => message.error(String(e)))}>保存模型</Button>
            </Form>
          </Card>

          <Table<AiProfile>
            className="subsection-table"
            rowKey="id"
            pagination={false}
            dataSource={settings.ai_profiles}
            columns={[
              { title: "名称", dataIndex: "name" },
              { title: "Model", dataIndex: "model" },
              { title: "Base URL", dataIndex: "base_url", responsive: ["md"] },
              { title: "操作", render: (_: unknown, r: AiProfile) => <Button danger size="small" onClick={() => onDeleteAiProfile(r.id).catch((e) => message.error(String(e)))}>删除</Button> },
            ]}
            scroll={{ x: "max-content" }}
          />
        </Card>
      </Modal>

      <Modal
        title="修改主密码"
        open={changePwdOpen}
        onCancel={() => setChangePwdOpen(false)}
        onOk={() => onChangePassword().catch((e) => message.error(errText(e)))}
        okText="确认修改"
      >
        <Space direction="vertical" className="full-width" size={10}>
          <Input.Password placeholder="旧密码" value={changePwdOld} onChange={(e) => setChangePwdOld(e.target.value)} />
          <Input.Password placeholder="新密码（至少6位）" value={changePwdNew} onChange={(e) => setChangePwdNew(e.target.value)} />
          <Input.Password placeholder="确认新密码" value={changePwdConfirm} onChange={(e) => setChangePwdConfirm(e.target.value)} />
          <Typography.Text type="secondary">留空“新密码”和“确认新密码”并提交，可删除登录密码（免密码进入）。</Typography.Text>
        </Space>
      </Modal>

      <Modal
        title="清除所有交易记录"
        open={clearModalOpen}
        onCancel={() => {
          if (clearingTrades) return;
          setClearModalOpen(false);
          setClearConfirmText("");
        }}
        onOk={() => onClearAllTrades().catch((e) => message.error(errText(e)))}
        okText="确认删除"
        okButtonProps={{ danger: true, disabled: !canConfirmClear, loading: clearingTrades }}
        cancelButtonProps={{ disabled: clearingTrades }}
      >
        <Alert
          type="warning"
          showIcon
          message="该操作会删除数据库中所有交易记录和卖出配对明细，且不可恢复。"
          style={{ marginBottom: 12 }}
        />
        <Typography.Paragraph style={{ marginBottom: 8 }}>
          请输入确认词：<Typography.Text code>{confirmPhrase}</Typography.Text>
        </Typography.Paragraph>
        <Input
          placeholder="请输入确认词"
          value={clearConfirmText}
          onChange={(e) => setClearConfirmText(e.target.value)}
          disabled={clearingTrades}
        />
      </Modal>

      <Modal
        title="编辑交易记录"
        open={!!editingTrade}
        onCancel={() => setEditingTrade(null)}
        onOk={() => onSaveEdit().catch((e) => message.error(String(e)))}
        okText="保存"
        footer={(_, { OkBtn, CancelBtn }) => (
          <Space>
            <Button danger onClick={() => onDeleteTrade().catch((e) => message.error(errText(e)))}>删除该记录</Button>
            <CancelBtn />
            <OkBtn />
          </Space>
        )}
      >
        <Form form={editForm} layout="vertical">
          <Form.Item name="id" hidden><Input /></Form.Item>
          <Form.Item name="trade_date" label="成交日期" rules={[{ required: true }]}><Input placeholder="YYYY-MM-DD" /></Form.Item>
          <Form.Item name="trade_time" label="成交时间" rules={[{ required: true }]}><Input placeholder="HH:mm:ss（24小时制）" /></Form.Item>
          <Form.Item name="symbol" label="证券代码" rules={[{ required: true }]}>
            <Select
              showSearch
              allowClear
              placeholder="选择或输入证券代码"
              filterOption={false}
              notFoundContent={marketSearching ? "搜索中..." : "无匹配，可继续输入"}
              options={mergedSymbolOptions}
              onSearch={(v) => searchMarketStocks(v).catch(() => {})}
              onChange={(v) => {
                const selectedCode = String(v || "");
                const fromMarket = marketSearchOptions.find((x) => x.code === selectedCode);
                const name = fromMarket?.name || holdingMapBySymbol.get(selectedCode);
                if (name) editForm.setFieldValue("security_name", name);
              }}
            />
          </Form.Item>
          <Form.Item name="security_name" label="证券名称" rules={[{ required: true }]}>
            <Select
              showSearch
              allowClear
              placeholder="选择或输入证券名称"
              filterOption={false}
              notFoundContent={marketSearching ? "搜索中..." : "无匹配，可继续输入"}
              options={mergedNameOptions}
              onSearch={(v) => searchMarketStocks(v).catch(() => {})}
              onChange={(v) => {
                const selectedName = String(v || "");
                const fromMarket = marketSearchOptions.find((x) => x.name === selectedName);
                const code = fromMarket?.code || holdingMapByName.get(selectedName);
                if (code) editForm.setFieldValue("symbol", code);
              }}
            />
          </Form.Item>
          <Form.Item name="trade_no" label="成交编号">
            <Input placeholder="可选，若重复将自动跳过" />
          </Form.Item>
          <Form.Item name="side" label="买卖标志" rules={[{ required: true }]}> 
            <Select options={[{ label: "证券买入", value: "BUY" }, { label: "证券卖出", value: "SELL" }]} />
          </Form.Item>
          <Form.Item name="price" label="成交价格" rules={[{ required: true }]}><InputNumber min={0} step={0.01} style={{ width: "100%" }} /></Form.Item>
          <Form.Item name="quantity" label="成交数量" rules={[{ required: true }]}><InputNumber min={1} step={1} style={{ width: "100%" }} /></Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

export default App;
