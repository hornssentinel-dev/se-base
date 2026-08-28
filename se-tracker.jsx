import React, { useState, useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import {
  Plus, ChevronLeft, Trash2, FlaskConical, Briefcase, AlertTriangle,
  Target, FileText, MonitorPlay, NotebookPen, Download, Upload, Pencil, Check,
  X, Circle, CircleCheck, CircleX, CircleDot, Clock, Building2, Users, Swords,
  ArrowRight, Save, ListTodo, DollarSign, Image as ImageIcon, LayoutDashboard, Link
} from "lucide-react";

// ---- constants ---------------------------------------------------------------
const STORE_KEY = "se-tracker:opps:v1";
const BIZ_CASE_STORE_KEY = "se-tracker:bizcases:v1";
const TASKS_STORE_KEY = "se-tracker:tasks:v1";

const SE_STAGES = [
  "Discovery",
  "Technical validation",
  "PoC",
  "Technical win",
  "Handoff / closed",
];

const PRODUCTS = ["SWG", "CASB", "PA", "ADVDLP", "RBI", "DSPM", "ICAP", "FwaaS"];

const NOTE_TYPES = ["Discovery", "Call", "Demo", "POC", "Risk"];

const POC_STATUS = {
  pending: { label: "Pending", color: "#94a3b8", Icon: Circle },
  pass: { label: "Pass", color: "#34d399", Icon: CircleCheck },
  fail: { label: "Fail", color: "#fb7185", Icon: CircleX },
  blocked: { label: "Blocked", color: "#fbbf24", Icon: CircleDot },
};

const HEALTH = {
  none: { label: "No PoC", color: "#64748b", dot: "#475569" },
  green: { label: "Healthy", color: "#34d399", dot: "#34d399" },
  amber: { label: "At risk", color: "#fbbf24", dot: "#fbbf24" },
  red: { label: "Critical", color: "#fb7185", dot: "#fb7185" },
};

const uid = () => Math.random().toString(36).slice(2, 10);
const today = () => new Date().toISOString().slice(0, 10);
const formatAcv = (n) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(n || 0);

// an opp is closed (won or lost) once a disposition has been recorded — absent
// closeStatus means still open, so old data without the field needs no migration
const isClosed = (opp) => opp.closeStatus === "won" || opp.closeStatus === "lost";

// derive PoC health from criteria + dates
function derivePocHealth(opp) {
  const poc = opp.poc;
  if (!poc || !poc.active || !poc.criteria?.length) return "none";
  const statuses = poc.criteria.map((c) => c.status);
  if (statuses.includes("fail") || statuses.includes("blocked")) return "red";
  const allPass = statuses.every((s) => s === "pass");
  if (allPass) return "green";
  const overdue = poc.targetDate && poc.targetDate < today();
  if (overdue) return "amber";
  return "green";
}

const sampleOpp = () => ({
  id: uid(),
  account: "Nexum Financial",
  segment: "Enterprise · FinServ",
  acv: 185000,
  closeDate: addDays(45),
  seStage: "PoC",
  products: ["SWG", "CASB", "DLP"],
  acctMgr: "Priya Desai",
  champion: "Dana Okafor — Dir. Infrastructure",
  competitor: "Zscaler",
  nextAction: "Validate DLP inline scanning against their EDM fingerprints",
  createdAt: today(),
  closeStatus: "open",
  notes: [
    {
      id: uid(),
      date: today(),
      type: "Discovery",
      body: "Driver is M365 + Salesforce data exfil risk after a near-miss. Champion wants inline DLP, not just CASB API. Security team is 4 people, lean.",
    },
  ],
  demos: [
    {
      id: uid(),
      date: addDays(-7),
      products: ["SWG", "CASB"],
      audience: "Security team (4) + CISO",
      outcome: "positive",
      notes: "RBI isolation landed well. CISO asked about FedRAMP roadmap.",
    },
  ],
  poc: {
    active: true,
    startDate: addDays(-5),
    targetDate: addDays(16),
    criteria: [
      { id: uid(), label: "Inline SWG decrypt + DLP on M365 uploads", status: "pass", owner: "SE", note: "Verified with test ruleset." },
      { id: uid(), label: "EDM fingerprint match on customer PII set", status: "pending", owner: "SE", note: "" },
      { id: uid(), label: "CASB shadow-AI detection (ChatGPT, Claude, Gemini)", status: "pending", owner: "Joint", note: "" },
      { id: uid(), label: "ZTNA access to internal HR app, no VPN", status: "blocked", owner: "Customer", note: "Waiting on their AD group cleanup." },
    ],
  },
});

function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// downscale + re-encode as JPEG so pasted screenshots don't balloon storage.json
// (this is embedded inline as a data URL — there's no upload endpoint/blob store)
function fileToImage(file, maxDim = 1600, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---- storage layer -----------------------------------------------------------
async function loadOpps() {
  try {
    const res = await fetch(`/api/storage/${STORE_KEY}`);
    const data = await res.json();
    if (data.value) return JSON.parse(data.value);
  } catch (e) {
    console.error("Load failed", e);
  }
  return [];
}
async function persist(opps) {
  try {
    await fetch(`/api/storage/${STORE_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: JSON.stringify(opps) }),
    });
  } catch (e) {
    console.error("Save failed", e);
  }
}

// business case library is shared across every opportunity, not per-opp data
async function loadBizCases() {
  try {
    const res = await fetch(`/api/storage/${BIZ_CASE_STORE_KEY}`);
    const data = await res.json();
    if (data.value) return JSON.parse(data.value);
  } catch (e) {
    console.error("Load failed", e);
  }
  return [];
}
async function persistBizCases(cases) {
  try {
    await fetch(`/api/storage/${BIZ_CASE_STORE_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: JSON.stringify(cases) }),
    });
  } catch (e) {
    console.error("Save failed", e);
  }
}

// task list is also shared/global — a task references the opportunity it came from
async function loadTasks() {
  try {
    const res = await fetch(`/api/storage/${TASKS_STORE_KEY}`);
    const data = await res.json();
    if (data.value) return JSON.parse(data.value);
  } catch (e) {
    console.error("Load failed", e);
  }
  return [];
}
async function persistTasks(tasks) {
  try {
    await fetch(`/api/storage/${TASKS_STORE_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: JSON.stringify(tasks) }),
    });
  } catch (e) {
    console.error("Save failed", e);
  }
}

// ---- small UI atoms ----------------------------------------------------------
function StatTile({ Icon, label, value, sub, accent }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <div className="flex items-center gap-2 text-slate-400 text-xs uppercase tracking-wider">
        <Icon size={14} style={{ color: accent }} />
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold text-slate-100 tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

function HealthDot({ health }) {
  const h = HEALTH[health] || HEALTH.none;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: h.color }}>
      <span className="inline-block w-2 h-2 rounded-full" style={{ background: h.dot }} />
      {h.label}
    </span>
  );
}

function Pill({ children }) {
  return (
    <span className="inline-block rounded border border-slate-700 bg-slate-800 px-1.5 py-0.5 text-[11px] font-mono text-slate-300">
      {children}
    </span>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">{label}</span>
      {children}
    </label>
  );
}

const inputCls =
  "w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder-slate-600 focus:border-teal-500 focus:outline-none";

// ---- main component ----------------------------------------------------------
export default function SETracker() {
  const [opps, setOpps] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [tab, setTab] = useState("overview");
  const [mainView, setMainView] = useState("list"); // "list" | "dashboard"
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState("all");
  const [bizCases, setBizCases] = useState([]);
  const [bizLoaded, setBizLoaded] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [tasksLoaded, setTasksLoaded] = useState(false);

  // load once
  useEffect(() => {
    loadOpps().then((data) => {
      setOpps(data);
      setLoaded(true);
    });
    loadBizCases().then((data) => {
      setBizCases(data);
      setBizLoaded(true);
    });
    loadTasks().then((data) => {
      setTasks(data);
      setTasksLoaded(true);
    });
  }, []);

  // persist on change (after initial load)
  useEffect(() => {
    if (loaded) persist(opps);
  }, [opps, loaded]);

  useEffect(() => {
    if (bizLoaded) persistBizCases(bizCases);
  }, [bizCases, bizLoaded]);

  useEffect(() => {
    if (tasksLoaded) persistTasks(tasks);
  }, [tasks, tasksLoaded]);

  const selected = opps.find((o) => o.id === selectedId) || null;

  const update = (id, fn) =>
    setOpps((prev) => prev.map((o) => (o.id === id ? fn({ ...o }) : o)));

  const removeOpp = (id) => {
    setOpps((prev) => prev.filter((o) => o.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const openOpp = (id) => {
    setSelectedId(id);
    setTab("overview");
  };

  const addTask = (opp) => {
    if (!opp.nextAction?.trim()) return;
    const task = {
      id: uid(),
      text: opp.nextAction.trim(),
      oppId: opp.id,
      oppAccount: opp.account,
      createdAt: new Date().toISOString(),
      done: false,
    };
    setTasks((prev) => [task, ...prev]);
  };
  const toggleTask = (id) =>
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  const deleteTask = (id) => setTasks((prev) => prev.filter((t) => t.id !== id));

  // summary stats
  const stats = useMemo(() => {
    const open = opps.filter((o) => !isClosed(o));
    const livePocs = open.filter((o) => o.poc?.active);
    const atRisk = livePocs.filter((o) => ["amber", "red"].includes(derivePocHealth(o)));
    // closed-won and closed-lost ACV drops out — Total ACV reflects open pipeline only
    const totalAcv = open.reduce((sum, o) => sum + (Number(o.acv) || 0), 0);
    return {
      active: open.length,
      poc: livePocs.length,
      risk: atRisk.length,
      totalAcv,
    };
  }, [opps]);

  const filtered = useMemo(() => {
    if (filter === "all") return opps.filter((o) => !isClosed(o));
    if (filter === "poc") return opps.filter((o) => !isClosed(o) && o.poc?.active);
    if (filter === "risk")
      return opps.filter((o) => !isClosed(o) && ["amber", "red"].includes(derivePocHealth(o)));
    if (filter === "closed") return opps.filter(isClosed);
    return opps;
  }, [opps, filter]);

  // import / export
  const exportData = () => {
    const blob = new Blob([JSON.stringify(opps, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `se-tracker-${today()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const importData = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (Array.isArray(data)) setOpps(data);
      } catch (err) {
        console.error("Import failed", err);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  if (!loaded) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-500">
        <div className="flex items-center gap-2 text-sm">
          <Clock size={16} className="animate-spin" /> Loading your tracker…
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200" style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <div className="max-w-6xl mx-auto px-4 py-6">
        {/* header */}
        <div className="flex items-center justify-between flex-wrap gap-3 border-b border-slate-800 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <Target size={20} style={{ color: "#2dd4bf" }} />
              <h1 className="text-lg font-semibold text-slate-100">SE Tracker</h1>
              <span className="font-mono text-[11px] text-slate-600">technical pursuit log</span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Notes, demos and PoC validation — built for the SE seat, not the rep forecast.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={exportData}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-300 hover:border-slate-600"
            >
              <Download size={14} /> Export
            </button>
            <label className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-300 hover:border-slate-600 cursor-pointer">
              <Upload size={14} /> Import
              <input type="file" accept="application/json" onChange={importData} className="hidden" />
            </label>
            <button
              onClick={() => setAdding(true)}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium text-slate-950"
              style={{ background: "#2dd4bf" }}
            >
              <Plus size={14} /> New opportunity
            </button>
          </div>
        </div>

        {/* nav + stats — hidden while working inside an opportunity */}
        {!selected && (
          <>
            <div className="flex items-center gap-1.5 mt-5">
              <button
                onClick={() => setMainView("list")}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium ${
                  mainView === "list"
                    ? "bg-slate-800 text-slate-100"
                    : "text-slate-500 hover:text-slate-300"
                }`}
              >
                <Briefcase size={14} /> Pipeline
              </button>
              <button
                onClick={() => setMainView("dashboard")}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium ${
                  mainView === "dashboard"
                    ? "bg-slate-800 text-slate-100"
                    : "text-slate-500 hover:text-slate-300"
                }`}
              >
                <LayoutDashboard size={14} /> Financials
              </button>
            </div>

            {mainView === "list" && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
                <StatTile Icon={Briefcase} label="Active opps" value={stats.active} accent="#2dd4bf" />
                <StatTile Icon={FlaskConical} label="Live PoCs" value={stats.poc} accent="#38bdf8" />
                <StatTile Icon={AlertTriangle} label="PoCs at risk" value={stats.risk} accent="#fbbf24" sub={stats.risk ? "needs your attention" : "all clear"} />
              </div>
            )}
          </>
        )}

        {/* body */}
        {selected ? (
          <DetailView
            opp={selected}
            tab={tab}
            setTab={setTab}
            update={update}
            removeOpp={removeOpp}
            onBack={() => setSelectedId(null)}
            bizCases={bizCases}
            setBizCases={setBizCases}
            addTask={addTask}
          />
        ) : mainView === "dashboard" ? (
          <FinancialDashboard stats={stats} />
        ) : (
          <ListView
            opps={filtered}
            allOpps={opps}
            total={opps.length}
            filter={filter}
            setFilter={setFilter}
            onOpen={openOpp}
            onSeed={() => setOpps([sampleOpp()])}
            onAdd={() => setAdding(true)}
            tasks={tasks}
            onToggleTask={toggleTask}
            onDeleteTask={deleteTask}
          />
        )}
      </div>

      {adding && (
        <AddModal
          onClose={() => setAdding(false)}
          onCreate={(opp) => {
            setOpps((prev) => [opp, ...prev]);
            setAdding(false);
            setSelectedId(opp.id);
            setTab("overview");
          }}
        />
      )}
    </div>
  );
}

// ---- financial dashboard -------------------------------------------------------
function FinancialDashboard({ stats }) {
  return (
    <div className="mt-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <StatTile Icon={DollarSign} label="Total ACV" value={formatAcv(stats.totalAcv)} accent="#34d399" sub="open pipeline" />
      </div>
    </div>
  );
}

// ---- list view ---------------------------------------------------------------
function ListView({ opps, allOpps, total, filter, setFilter, onOpen, onSeed, onAdd, tasks, onToggleTask, onDeleteTask }) {
  if (total === 0) {
    return (
      <div className="mt-10 rounded-xl border border-dashed border-slate-800 bg-slate-900/50 p-10 text-center">
        <Target size={28} className="mx-auto text-slate-600" />
        <h2 className="mt-3 text-slate-200 font-medium">No opportunities yet</h2>
        <p className="mt-1 text-sm text-slate-500 max-w-md mx-auto">
          Add the accounts you're supporting and start logging discovery notes, demos and PoC criteria. Everything you enter saves automatically.
        </p>
        <div className="mt-5 flex items-center justify-center gap-2">
          <button onClick={onAdd} className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium text-slate-950" style={{ background: "#2dd4bf" }}>
            <Plus size={14} /> Add your first opportunity
          </button>
          <button onClick={onSeed} className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-300 hover:border-slate-600">
            Load a sample to explore
          </button>
        </div>
      </div>
    );
  }

  const closedCount = allOpps.filter(isClosed).length;
  const filters = [
    { key: "all", label: "All" },
    { key: "poc", label: "Live PoCs" },
    { key: "risk", label: "At risk" },
    { key: "closed", label: `Closed (${closedCount})` },
    { key: "tasks", label: `Tasks (${tasks.length})` },
  ];

  return (
    <div className="mt-5">
      <div className="flex items-center gap-1.5 mb-3">
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs border ${
              filter === f.key
                ? "border-teal-500 bg-teal-500/10 text-teal-300"
                : "border-slate-800 bg-slate-900 text-slate-400 hover:border-slate-700"
            }`}
          >
            {f.key === "tasks" && <ListTodo size={12} />}
            {f.label}
          </button>
        ))}
      </div>

      {filter === "tasks" ? (
        <TaskPanel tasks={tasks} opps={allOpps} onToggle={onToggleTask} onDelete={onDeleteTask} onOpenOpp={onOpen} />
      ) : (
      <div className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-900 text-left text-[11px] uppercase tracking-wider text-slate-500">
              <th className="px-3 py-2 font-medium">Account</th>
              <th className="px-3 py-2 font-medium">Acct Mgr</th>
              <th className="px-3 py-2 font-medium">SE stage</th>
              {filter === "closed" ? (
                <th className="px-3 py-2 font-medium">Result</th>
              ) : (
                <th className="px-3 py-2 font-medium">PoC health</th>
              )}
              <th className="px-3 py-2 font-medium">Products</th>
              <th className="px-3 py-2 font-medium">Next SE action</th>
            </tr>
          </thead>
          <tbody>
            {opps.map((o) => (
              <tr
                key={o.id}
                onClick={() => onOpen(o.id)}
                className="border-t border-slate-800 cursor-pointer hover:bg-slate-900/60"
              >
                <td className="px-3 py-3">
                  <div className="font-medium text-slate-100">{o.account}</div>
                  <div className="text-xs text-slate-500">{o.segment}</div>
                </td>
                <td className="px-3 py-3">
                  <span className="text-xs text-slate-300">{o.acctMgr || "—"}</span>
                </td>
                <td className="px-3 py-3">
                  <span className="text-xs text-slate-300">{o.seStage}</span>
                </td>
                {filter === "closed" ? (
                  <td className="px-3 py-3">
                    <span
                      className="text-xs font-medium"
                      style={{ color: o.closeStatus === "won" ? "#34d399" : "#fb7185" }}
                    >
                      {o.closeStatus === "won" ? "Won" : "Lost"}
                    </span>
                  </td>
                ) : (
                  <td className="px-3 py-3">
                    <HealthDot health={derivePocHealth(o)} />
                  </td>
                )}
                <td className="px-3 py-3">
                  <div className="flex flex-wrap gap-1">
                    {(o.products || []).map((p) => (
                      <Pill key={p}>{p}</Pill>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-3 text-xs text-slate-400 max-w-xs">{o.nextAction || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
    </div>
  );
}

// ---- task panel ---------------------------------------------------------------
function TaskPanel({ tasks, opps, onToggle, onDelete, onOpenOpp }) {
  if (tasks.length === 0) {
    return <Empty msg={`No tasks yet. Use "Add to tasks" next to Next SE action on an opportunity.`} />;
  }

  const sorted = [...tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return b.createdAt.localeCompare(a.createdAt);
  });

  return (
    <div className="space-y-2">
      {sorted.map((t) => {
        const oppExists = opps.some((o) => o.id === t.oppId);
        return (
          <div key={t.id} className={`rounded-lg border border-slate-800 bg-slate-900 p-3 flex items-start gap-3 ${t.done ? "opacity-50" : ""}`}>
            <button onClick={() => onToggle(t.id)} className="mt-0.5 text-slate-500 hover:text-teal-300">
              {t.done ? <CircleCheck size={16} className="text-teal-400" /> : <Circle size={16} />}
            </button>
            <div className="flex-1">
              <p className={`text-sm text-slate-200 ${t.done ? "line-through" : ""}`}>{t.text}</p>
              <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
                <button
                  onClick={() => oppExists && onOpenOpp(t.oppId)}
                  disabled={!oppExists}
                  className={oppExists ? "font-medium text-teal-400 hover:text-teal-300" : "text-slate-600"}
                >
                  {t.oppAccount}
                </button>
                <span>·</span>
                <span className="font-mono">{new Date(t.createdAt).toLocaleString()}</span>
              </div>
            </div>
            <button onClick={() => onDelete(t.id)} className="text-slate-600 hover:text-rose-400">
              <Trash2 size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ---- detail view -------------------------------------------------------------
function DetailView({ opp, tab, setTab, update, removeOpp, onBack, bizCases, setBizCases, addTask }) {
  const tabs = [
    { key: "overview", label: "Overview", Icon: FileText },
    { key: "notes", label: `Notes (${opp.notes?.length || 0})`, Icon: NotebookPen },
    { key: "demos", label: `Demos (${opp.demos?.length || 0})`, Icon: MonitorPlay },
    { key: "poc", label: "PoC", Icon: FlaskConical },
    { key: "bizcase", label: "Business Case", Icon: Briefcase },
  ];

  const closeOpp = (status) => {
    const verb = status === "won" ? "Win" : "Loss";
    if (!confirm(`Mark ${opp.account} as Closed ${verb}? It will move out of your active opportunities into the Closed list.`)) return;
    update(opp.id, (o) => ({ ...o, closeStatus: status, closedAt: today() }));
    onBack();
  };
  const reopenOpp = () => update(opp.id, (o) => ({ ...o, closeStatus: "open", closedAt: undefined }));

  return (
    <div className="mt-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <button onClick={onBack} className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-slate-200">
          <ChevronLeft size={16} /> All opportunities
        </button>
        <div className="flex items-center gap-3">
          {isClosed(opp) ? (
            <button onClick={reopenOpp} className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200">
              <ArrowRight size={14} /> Reopen opportunity
            </button>
          ) : (
            <>
              <button
                onClick={() => closeOpp("won")}
                className="inline-flex items-center gap-1.5 rounded-md border border-emerald-700 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-500/20"
              >
                <Check size={14} /> Close Win
              </button>
              <button
                onClick={() => closeOpp("lost")}
                className="inline-flex items-center gap-1.5 rounded-md border border-rose-700 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-300 hover:bg-rose-500/20"
              >
                <X size={14} /> Close Loss
              </button>
            </>
          )}
          <button
            onClick={() => {
              if (confirm(`Delete ${opp.account} and all its notes, demos and PoC data?`)) removeOpp(opp.id);
            }}
            className="inline-flex items-center gap-1.5 text-xs text-rose-400 hover:text-rose-300"
          >
            <Trash2 size={14} /> Delete opportunity
          </button>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-3 flex-wrap">
        <h2 className="text-xl font-semibold text-slate-100">{opp.account}</h2>
        {isClosed(opp) ? (
          <span
            className="inline-flex items-center gap-1.5 text-xs font-medium"
            style={{ color: opp.closeStatus === "won" ? "#34d399" : "#fb7185" }}
          >
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ background: opp.closeStatus === "won" ? "#34d399" : "#fb7185" }}
            />
            Closed · {opp.closeStatus === "won" ? "Won" : "Lost"}
          </span>
        ) : (
          <HealthDot health={derivePocHealth(opp)} />
        )}
        <span className="text-xs text-slate-500">{opp.segment}</span>
      </div>

      {/* tabs */}
      <div className="mt-4 flex items-center gap-1 border-b border-slate-800">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px ${
              tab === t.key
                ? "border-teal-500 text-teal-300"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            <t.Icon size={14} /> {t.label}
          </button>
        ))}
      </div>

      <div className="mt-5">
        {tab === "overview" && <OverviewTab opp={opp} update={update} addTask={addTask} />}
        {tab === "notes" && <NotesTab opp={opp} update={update} />}
        {tab === "demos" && <DemosTab opp={opp} update={update} />}
        {tab === "poc" && <PocTab opp={opp} update={update} />}
        {tab === "bizcase" && <BizCaseTab opp={opp} bizCases={bizCases} setBizCases={setBizCases} />}
      </div>
    </div>
  );
}

// ---- overview tab ------------------------------------------------------------
function OverviewTab({ opp, update, addTask }) {
  const set = (key, val) => update(opp.id, (o) => ({ ...o, [key]: val }));
  const toggleProduct = (p) =>
    update(opp.id, (o) => {
      const has = o.products?.includes(p);
      return { ...o, products: has ? o.products.filter((x) => x !== p) : [...(o.products || []), p] };
    });

  return (
    <div className="grid md:grid-cols-2 gap-5">
      <div className="space-y-4">
        <Field label="SE stage">
          <select className={inputCls} value={opp.seStage} onChange={(e) => set("seStage", e.target.value)}>
            {SE_STAGES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </Field>

        <Field label="Products under evaluation">
          <div className="flex flex-wrap gap-1.5">
            {PRODUCTS.map((p) => {
              const on = opp.products?.includes(p);
              return (
                <button
                  key={p}
                  onClick={() => toggleProduct(p)}
                  className={`rounded px-2 py-1 text-xs font-mono border ${
                    on
                      ? "border-teal-500 bg-teal-500/10 text-teal-300"
                      : "border-slate-700 bg-slate-900 text-slate-500 hover:border-slate-600"
                  }`}
                >
                  {p}
                </button>
              );
            })}
          </div>
        </Field>

        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="block text-[11px] uppercase tracking-wider text-slate-500">Next SE action</span>
            <button
              onClick={() => addTask(opp)}
              disabled={!opp.nextAction?.trim()}
              className="inline-flex items-center gap-1 text-[11px] text-teal-300 hover:text-teal-200 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ListTodo size={12} /> Add to tasks
            </button>
          </div>
          <textarea
            className={inputCls}
            rows={2}
            value={opp.nextAction || ""}
            onChange={(e) => set("nextAction", e.target.value)}
            placeholder="The one thing only the SE can move forward…"
          />
        </div>
      </div>

      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="ACV ($)">
            <input
              type="number"
              className={inputCls}
              value={opp.acv || ""}
              onChange={(e) => set("acv", Number(e.target.value))}
            />
          </Field>
          <Field label="Target close">
            <input type="date" className={inputCls} value={opp.closeDate || ""} onChange={(e) => set("closeDate", e.target.value)} />
          </Field>
        </div>

        <Field label="Acct Mgr">
          <div className="flex items-center gap-2">
            <Briefcase size={15} className="text-slate-500" />
            <input className={inputCls} value={opp.acctMgr || ""} onChange={(e) => set("acctMgr", e.target.value)} placeholder="Owning account manager" />
          </div>
        </Field>

        <Field label="Champion">
          <div className="flex items-center gap-2">
            <Users size={15} className="text-slate-500" />
            <input className={inputCls} value={opp.champion || ""} onChange={(e) => set("champion", e.target.value)} placeholder="Name — role" />
          </div>
        </Field>

        <Field label="Primary competitor">
          <div className="flex items-center gap-2">
            <Swords size={15} className="text-slate-500" />
            <input className={inputCls} value={opp.competitor || ""} onChange={(e) => set("competitor", e.target.value)} placeholder="e.g. Zscaler, Netskope, Palo Alto" />
          </div>
        </Field>

        <Field label="Segment">
          <div className="flex items-center gap-2">
            <Building2 size={15} className="text-slate-500" />
            <input className={inputCls} value={opp.segment || ""} onChange={(e) => set("segment", e.target.value)} />
          </div>
        </Field>

        <Field label="Salesforce link">
          <div className="flex items-center gap-2">
            <Link size={15} className="text-slate-500" />
            <input
              className={inputCls}
              value={opp.sfdcUrl || ""}
              onChange={(e) => set("sfdcUrl", e.target.value)}
              placeholder="https://yourorg.lightning.force.com/..."
            />
            {opp.sfdcUrl && (
              <a
                href={opp.sfdcUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-blue-600 hover:underline whitespace-nowrap"
              >
                Open
              </a>
            )}
          </div>
        </Field>
      </div>
    </div>
  );
}

// ---- notes tab ---------------------------------------------------------------
function NotesTab({ opp, update }) {
  const [type, setType] = useState("Discovery");
  const [body, setBody] = useState("");
  const [draftImages, setDraftImages] = useState([]);
  const [lightbox, setLightbox] = useState(null);

  const addFiles = async (files) => {
    const imageFiles = [...files].filter((f) => f.type.startsWith("image/"));
    if (!imageFiles.length) return;
    const dataUrls = await Promise.all(imageFiles.map((f) => fileToImage(f)));
    setDraftImages((prev) => [...prev, ...dataUrls.map((dataUrl) => ({ id: uid(), dataUrl }))]);
  };

  const onFilePick = (e) => {
    addFiles(e.target.files);
    e.target.value = "";
  };
  const onPaste = (e) => {
    const files = [...e.clipboardData.items]
      .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
      .map((i) => i.getAsFile());
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  };
  const removeDraftImage = (id) => setDraftImages((prev) => prev.filter((img) => img.id !== id));

  const add = () => {
    if (!body.trim() && draftImages.length === 0) return;
    const note = { id: uid(), date: today(), type, body: body.trim(), images: draftImages };
    update(opp.id, (o) => ({ ...o, notes: [note, ...(o.notes || [])] }));
    setBody("");
    setDraftImages([]);
  };
  const del = (id) => update(opp.id, (o) => ({ ...o, notes: o.notes.filter((n) => n.id !== id) }));

  return (
    <div>
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-3">
        <div className="flex items-center gap-2 mb-2">
          {NOTE_TYPES.map((t) => (
            <button
              key={t}
              onClick={() => setType(t)}
              className={`rounded px-2 py-1 text-[11px] border ${
                type === t ? "border-teal-500 bg-teal-500/10 text-teal-300" : "border-slate-700 bg-slate-950 text-slate-400"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <textarea
          className={inputCls}
          rows={3}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onPaste={onPaste}
          placeholder="What did you learn? Decision drivers, technical requirements, objections, who said what… (paste a screenshot to attach it)"
        />
        {draftImages.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {draftImages.map((img) => (
              <div key={img.id} className="relative">
                <img src={img.dataUrl} className="w-16 h-16 object-cover rounded border border-slate-700" />
                <button
                  onClick={() => removeDraftImage(img.id)}
                  className="absolute -top-1.5 -right-1.5 rounded-full bg-slate-950 border border-slate-700 text-slate-400 hover:text-rose-400"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex justify-between items-center mt-2">
          <label className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-400 hover:border-slate-600 cursor-pointer">
            <ImageIcon size={13} /> Attach image
            <input type="file" accept="image/*" multiple onChange={onFilePick} className="hidden" />
          </label>
          <button onClick={add} className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-slate-950" style={{ background: "#2dd4bf" }}>
            <Plus size={14} /> Add note
          </button>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {(opp.notes || []).length === 0 && <Empty msg="No notes yet. Capture discovery while it's fresh." />}
        {(opp.notes || []).map((n) => (
          <div key={n.id} className="rounded-lg border border-slate-800 bg-slate-900 p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Pill>{n.type}</Pill>
                <span className="font-mono text-[11px] text-slate-500">{n.date}</span>
              </div>
              <button onClick={() => del(n.id)} className="text-slate-600 hover:text-rose-400">
                <Trash2 size={14} />
              </button>
            </div>
            {n.body && <p className="mt-2 text-sm text-slate-300 whitespace-pre-wrap">{n.body}</p>}
            {n.images?.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {n.images.map((img) => (
                  <img
                    key={img.id}
                    src={img.dataUrl}
                    onClick={() => setLightbox(img.dataUrl)}
                    className="w-20 h-20 object-cover rounded border border-slate-700 cursor-pointer hover:border-teal-600"
                  />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
          onClick={() => setLightbox(null)}
        >
          <img src={lightbox} className="max-w-full max-h-full rounded-lg" />
        </div>
      )}
    </div>
  );
}

// ---- demos tab ---------------------------------------------------------------
function DemosTab({ opp, update }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ date: today(), products: [], audience: "", outcome: "positive", notes: "" });

  const toggleP = (p) =>
    setDraft((d) => ({ ...d, products: d.products.includes(p) ? d.products.filter((x) => x !== p) : [...d.products, p] }));

  const add = () => {
    const demo = { ...draft, id: uid() };
    update(opp.id, (o) => ({ ...o, demos: [demo, ...(o.demos || [])] }));
    setDraft({ date: today(), products: [], audience: "", outcome: "positive", notes: "" });
    setOpen(false);
  };
  const del = (id) => update(opp.id, (o) => ({ ...o, demos: o.demos.filter((d) => d.id !== id) }));

  const outcomeColor = { positive: "#34d399", neutral: "#94a3b8", negative: "#fb7185" };

  return (
    <div>
      {!open && (
        <button onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-300 hover:border-slate-600">
          <Plus size={14} /> Log a demo
        </button>
      )}

      {open && (
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-3 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date">
              <input type="date" className={inputCls} value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
            </Field>
            <Field label="Outcome">
              <select className={inputCls} value={draft.outcome} onChange={(e) => setDraft({ ...draft, outcome: e.target.value })}>
                <option value="positive">Positive</option>
                <option value="neutral">Neutral</option>
                <option value="negative">Needs work</option>
              </select>
            </Field>
          </div>
          <Field label="Products shown">
            <div className="flex flex-wrap gap-1.5">
              {PRODUCTS.map((p) => (
                <button
                  key={p}
                  onClick={() => toggleP(p)}
                  className={`rounded px-2 py-1 text-xs font-mono border ${
                    draft.products.includes(p) ? "border-teal-500 bg-teal-500/10 text-teal-300" : "border-slate-700 bg-slate-950 text-slate-500"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Audience">
            <input className={inputCls} value={draft.audience} onChange={(e) => setDraft({ ...draft, audience: e.target.value })} placeholder="Who was in the room / on the call" />
          </Field>
          <Field label="Notes">
            <textarea className={inputCls} rows={2} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="What resonated, what fell flat, follow-ups raised" />
          </Field>
          <div className="flex justify-end gap-2">
            <button onClick={() => setOpen(false)} className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-400">Cancel</button>
            <button onClick={add} className="rounded-md px-3 py-1.5 text-xs font-medium text-slate-950" style={{ background: "#2dd4bf" }}>Save demo</button>
          </div>
        </div>
      )}

      <div className="mt-4 space-y-3">
        {(opp.demos || []).length === 0 && !open && <Empty msg="No demos logged yet." />}
        {(opp.demos || []).map((d) => (
          <div key={d.id} className="rounded-lg border border-slate-800 bg-slate-900 p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-[11px] text-slate-500">{d.date}</span>
                {(d.products || []).map((p) => <Pill key={p}>{p}</Pill>)}
                <span className="text-[11px]" style={{ color: outcomeColor[d.outcome] }}>● {d.outcome}</span>
              </div>
              <button onClick={() => del(d.id)} className="text-slate-600 hover:text-rose-400"><Trash2 size={14} /></button>
            </div>
            {d.audience && <div className="mt-1.5 text-xs text-slate-400">👥 {d.audience}</div>}
            {d.notes && <p className="mt-1.5 text-sm text-slate-300 whitespace-pre-wrap">{d.notes}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- poc tab -----------------------------------------------------------------
function PocTab({ opp, update }) {
  const poc = opp.poc || { active: false, criteria: [] };
  const [label, setLabel] = useState("");
  const [owner, setOwner] = useState("SE");

  const setPoc = (fn) => update(opp.id, (o) => ({ ...o, poc: fn({ ...(o.poc || { active: false, criteria: [] }) }) }));

  const startPoc = () =>
    setPoc((p) => ({ ...p, active: true, startDate: p.startDate || today(), targetDate: p.targetDate || addDays(21), criteria: p.criteria || [] }));
  const stopPoc = () => setPoc((p) => ({ ...p, active: false }));

  const addCriterion = () => {
    if (!label.trim()) return;
    setPoc((p) => ({ ...p, criteria: [...(p.criteria || []), { id: uid(), label: label.trim(), status: "pending", owner, note: "" }] }));
    setLabel("");
  };
  const setStatus = (cid, status) =>
    setPoc((p) => ({ ...p, criteria: p.criteria.map((c) => (c.id === cid ? { ...c, status } : c)) }));
  const setNote = (cid, note) =>
    setPoc((p) => ({ ...p, criteria: p.criteria.map((c) => (c.id === cid ? { ...c, note } : c)) }));
  const delCriterion = (cid) =>
    setPoc((p) => ({ ...p, criteria: p.criteria.filter((c) => c.id !== cid) }));

  if (!poc.active) {
    return (
      <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/50 p-8 text-center">
        <FlaskConical size={26} className="mx-auto text-slate-600" />
        <h3 className="mt-2 text-slate-200 font-medium">No active PoC</h3>
        <p className="mt-1 text-sm text-slate-500 max-w-sm mx-auto">
          Spin up a PoC to track success criteria with pass/fail status. Defined exit criteria are how you turn an eval into a technical win.
        </p>
        <button onClick={startPoc} className="mt-4 inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium text-slate-950" style={{ background: "#2dd4bf" }}>
          <Plus size={14} /> Start a PoC
        </button>
      </div>
    );
  }

  const counts = poc.criteria.reduce((a, c) => { a[c.status] = (a[c.status] || 0) + 1; return a; }, {});
  const total = poc.criteria.length || 1;
  const passPct = Math.round(((counts.pass || 0) / total) * 100);

  return (
    <div>
      {/* poc header */}
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <HealthDot health={derivePocHealth(opp)} />
            <span className="text-xs text-slate-500">{passPct}% criteria passing</span>
          </div>
          <button onClick={stopPoc} className="text-xs text-slate-500 hover:text-slate-300">End PoC</button>
        </div>
        <div className="mt-3 h-2 rounded-full bg-slate-800 overflow-hidden">
          <div className="h-full rounded-full" style={{ width: `${passPct}%`, background: "#34d399" }} />
        </div>
        <div className="grid grid-cols-2 gap-3 mt-3">
          <Field label="Start date">
            <input type="date" className={inputCls} value={poc.startDate || ""} onChange={(e) => setPoc((p) => ({ ...p, startDate: e.target.value }))} />
          </Field>
          <Field label="Target / decision date">
            <input type="date" className={inputCls} value={poc.targetDate || ""} onChange={(e) => setPoc((p) => ({ ...p, targetDate: e.target.value }))} />
          </Field>
        </div>
      </div>

      {/* add criterion */}
      <div className="mt-4 flex items-end gap-2">
        <div className="flex-1">
          <Field label="Add success criterion">
            <input
              className={inputCls}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addCriterion()}
              placeholder="e.g. EDM fingerprint match on customer PII set"
            />
          </Field>
        </div>
        <select className={inputCls + " w-28"} value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option>SE</option>
          <option>Customer</option>
          <option>Joint</option>
        </select>
        <button onClick={addCriterion} className="rounded-md px-3 py-2 text-xs font-medium text-slate-950" style={{ background: "#2dd4bf" }}>Add</button>
      </div>

      {/* criteria list */}
      <div className="mt-4 space-y-2">
        {poc.criteria.length === 0 && <Empty msg="Define your exit criteria above." />}
        {poc.criteria.map((c) => (
          <div key={c.id} className="rounded-lg border border-slate-800 bg-slate-900 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <div className="text-sm text-slate-200">{c.label}</div>
                <div className="mt-0.5 text-[11px] text-slate-500">Owner: {c.owner}</div>
              </div>
              <button onClick={() => delCriterion(c.id)} className="text-slate-600 hover:text-rose-400 mt-0.5"><Trash2 size={14} /></button>
            </div>
            <div className="mt-2 flex items-center gap-1.5">
              {Object.entries(POC_STATUS).map(([key, s]) => {
                const on = c.status === key;
                const SIcon = s.Icon;
                return (
                  <button
                    key={key}
                    onClick={() => setStatus(c.id, key)}
                    className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] border"
                    style={{
                      borderColor: on ? s.color : "#334155",
                      background: on ? s.color + "1a" : "transparent",
                      color: on ? s.color : "#64748b",
                    }}
                  >
                    <SIcon size={12} /> {s.label}
                  </button>
                );
              })}
            </div>
            <input
              className="mt-2 w-full rounded border border-slate-800 bg-slate-950 px-2 py-1.5 text-xs text-slate-300 placeholder-slate-600 focus:border-teal-600 focus:outline-none"
              value={c.note || ""}
              onChange={(e) => setNote(c.id, e.target.value)}
              placeholder="Evidence / blocker / note…"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- business case tab --------------------------------------------------------
// Shared library of business-value talking points per product, persisted
// globally (not per-opp) so it stays the same reference set across every
// opportunity and can be curated over time.
function BizCaseTab({ opp, bizCases, setBizCases }) {
  const [activeProduct, setActiveProduct] = useState(opp.products?.[0] || PRODUCTS[0]);
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");

  const casesForProduct = bizCases.filter((c) => c.product === activeProduct);

  const addCase = () => {
    if (!title.trim()) return;
    setBizCases((prev) => [
      ...prev,
      { id: uid(), product: activeProduct, title: title.trim(), detail: detail.trim() },
    ]);
    setTitle("");
    setDetail("");
  };
  const delCase = (id) => setBizCases((prev) => prev.filter((c) => c.id !== id));
  const setCaseDetail = (id, val) =>
    setBizCases((prev) => prev.map((c) => (c.id === id ? { ...c, detail: val } : c)));

  return (
    <div>
      <p className="text-xs text-slate-500 max-w-2xl">
        A shared library of business-value talking points per product, for tying technical capability back to the business case.
        Edits apply everywhere this product comes up, not just this opportunity.
      </p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {PRODUCTS.map((p) => {
          const on = p === activeProduct;
          const inDeal = opp.products?.includes(p);
          const count = bizCases.filter((c) => c.product === p).length;
          return (
            <button
              key={p}
              onClick={() => setActiveProduct(p)}
              className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-mono border ${
                on
                  ? "border-teal-500 bg-teal-500/10 text-teal-300"
                  : "border-slate-700 bg-slate-900 text-slate-500 hover:border-slate-600"
              }`}
              title={inDeal ? `${p} — in this opportunity` : p}
            >
              {inDeal && <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: on ? "#2dd4bf" : "#475569" }} />}
              {p}
              <span className="text-slate-600">({count})</span>
            </button>
          );
        })}
      </div>

      <div className="mt-4 rounded-lg border border-slate-800 bg-slate-900 p-3 space-y-2">
        <Field label={`Add a ${activeProduct} business case`}>
          <input
            className={inputCls}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addCase()}
            placeholder="e.g. Cuts SOC alert triage time by consolidating policy in one place"
          />
        </Field>
        <textarea
          className={inputCls}
          rows={2}
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
          placeholder="Supporting detail, proof point, or the technical capability behind it…"
        />
        <div className="flex justify-end">
          <button onClick={addCase} className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-slate-950" style={{ background: "#2dd4bf" }}>
            <Plus size={14} /> Add business case
          </button>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {casesForProduct.length === 0 && <Empty msg={`No business cases logged for ${activeProduct} yet.`} />}
        {casesForProduct.map((c) => (
          <div key={c.id} className="rounded-lg border border-slate-800 bg-slate-900 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="text-sm text-slate-200">{c.title}</div>
              <button onClick={() => delCase(c.id)} className="text-slate-600 hover:text-rose-400 mt-0.5"><Trash2 size={14} /></button>
            </div>
            <textarea
              className="mt-2 w-full rounded border border-slate-800 bg-slate-950 px-2 py-1.5 text-xs text-slate-300 placeholder-slate-600 focus:border-teal-600 focus:outline-none"
              rows={2}
              value={c.detail || ""}
              onChange={(e) => setCaseDetail(c.id, e.target.value)}
              placeholder="Supporting detail, proof point…"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- add modal ---------------------------------------------------------------
function AddModal({ onClose, onCreate }) {
  const [account, setAccount] = useState("");
  const [segment, setSegment] = useState("");
  const [seStage, setSeStage] = useState(SE_STAGES[0]);
  const [acctMgr, setAcctMgr] = useState("");

  const create = () => {
    if (!account.trim()) return;
    onCreate({
      id: uid(),
      account: account.trim(),
      segment: segment.trim(),
      seStage,
      acctMgr: acctMgr.trim(),
      acv: 0,
      closeDate: "",
      products: [],
      champion: "",
      competitor: "",
      nextAction: "",
      createdAt: today(),
      closeStatus: "open",
      notes: [],
      demos: [],
      poc: { active: false, criteria: [] },
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-slate-100 font-medium">New opportunity</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300"><X size={18} /></button>
        </div>
        <div className="space-y-3">
          <Field label="Account name">
            <input autoFocus className={inputCls} value={account} onChange={(e) => setAccount(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} placeholder="Acme Corp" />
          </Field>
          <Field label="Segment">
            <input className={inputCls} value={segment} onChange={(e) => setSegment(e.target.value)} placeholder="Enterprise · Healthcare" />
          </Field>
          <Field label="Acct Mgr">
            <input className={inputCls} value={acctMgr} onChange={(e) => setAcctMgr(e.target.value)} placeholder="Owning account manager" />
          </Field>
          <Field label="Starting SE stage">
            <select className={inputCls} value={seStage} onChange={(e) => setSeStage(e.target.value)}>
              {SE_STAGES.map((s) => <option key={s}>{s}</option>)}
            </select>
          </Field>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md border border-slate-700 px-3 py-2 text-xs text-slate-400">Cancel</button>
          <button onClick={create} className="rounded-md px-3 py-2 text-xs font-medium text-slate-950" style={{ background: "#2dd4bf" }}>Create</button>
        </div>
      </div>
    </div>
  );
}

function Empty({ msg }) {
  return <div className="text-center text-sm text-slate-600 py-6">{msg}</div>;
}

// ---- mount ---------------------------------------------------------------
createRoot(document.getElementById("root")).render(<SETracker />);
