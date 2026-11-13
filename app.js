"use strict";

/* ============================================================
 * 待办清单 - Web 内核
 * M1：添加 / 编辑 / 删除 / 完成 / 筛选 / 排序 / 本地持久化
 * M2：备注 / 批量清理 / 拖拽排序 / 到期提醒 / 标签 / 优先级
 *     主题切换 / 搜索 / 导入导出 / 重复任务（每日 / 每周指定星期）
 * 按天日程：任务可设开始日期，每天一栏，左右切换 + 小日历选择
 * ============================================================ */

/* ---------------- 存储层 ----------------
 * Electron：整份快照经 IPC 落盘 userData/todolist-data.json（防抖 250ms，关窗前同步刷盘）；
 * 浏览器开发模式：自动回退 localStorage。接口与 localStorage 一致。 */
const LS = (() => {
  const api = typeof window !== "undefined" ? window.electronAPI : null;
  if (api && api.storeRead) {
    const snap = api.storeRead() || {};
    let timer = null;
    const dump = () => JSON.stringify(snap);
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => api.storeWrite(dump()), 250);
    };
    window.addEventListener("beforeunload", () => {
      clearTimeout(timer);
      api.storeFlush(dump());
    });
    return {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(snap, k) ? snap[k] : null),
      setItem: (k, v) => { snap[k] = String(v); schedule(); },
      removeItem: (k) => { delete snap[k]; schedule(); },
    };
  }
  return localStorage;
})();

/* ---------------- 数据层 ---------------- */
const STORAGE_KEY = "todo.tasks.v1";
const SETTINGS_KEY = "todo.settings.v1";
/* v5 同步层存储键：必须在此声明（启动时即会用到，
 * 若放在文件后段的 v5 区块会触发 TDZ ReferenceError 中断整个脚本） */
const OP_OUTBOX_KEY = "todolist.ops.outbox.v1";
const OP_CURSOR_KEY = "todolist.ops.cursor.v1";
const OP_APPLIED_KEY = "todolist.ops.applied.v1";
const OP_META_KEY = "todolist.ops.taskmeta.v1";
const OP_CKPT_KEY = "todolist.ops.ckpt.v1";
const DEVICE_ID_KEY = "todolist.deviceId.v1";

let tasks = loadTasks();
let settings = Object.assign(
  { theme: "light", sortMode: "due", sound: true, notifications: true, closeBehavior: "tray", style: "things", accent: "blue" },
  loadSettings()
);
if (!["things", "soft"].includes(settings.style)) settings.style = "things";
let currentFilter = "all";
let activeTags = new Set();  // 当前标签筛选（多选，任一命中）
let tagsOpen = false;        // 标签行是否被用户展开
let tagsExpanded = false;    // 标签栏是否展开
let tagsOverflow = false;    // 标签栏是否超过一行（决定折叠按钮）
let searchQuery = "";        // 搜索关键词（小写）
let editingId = null;        // 当前编辑的任务 id（null 表示新建）
let confirmCallback = null;  // 确认弹窗回调
let dragId = null;           // 正在拖拽的任务 id
let dropPos = null;          // 拖拽落点 { id, before }
let selectedDate = todayKey(); // 当前查看的日期（YYYY-MM-DD）
let calMonth = new Date();     // 小日历显示的月份

function loadTasks() {
  try {
    const raw = LS.getItem(STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(arr)
      ? arr.filter((t) => t && typeof t === "object").map(normalizeTask)
      : [];
    list.forEach((t, i) => { if (typeof t.ord !== "number") t.ord = i; }); // 旧数据补序号
    return list;
  } catch {
    return [];
  }
}

function saveTasks() {
  if (!applyingRemote) {
    // 逐条比对签名：内容变了的盖 updatedAt；消失的记删除墓碑（v4 合并依据）
    // v5：diff 的同时产出操作 op（add/update/delete）入 outbox
    const now = Date.now();
    const recordOps = oplogActive();
    const added = [];
    const changed = [];
    const removed = [];
    const next = new Map();
    for (const t of tasks) {
      const sig = JSON.stringify(packTask(t));
      next.set(t.id, sig);
      if (lastSig.size && lastSig.get(t.id) !== sig) {
        const oldSig = lastSig.get(t.id);
        t.updatedAt = now;
        if (recordOps) {
          if (oldSig === undefined) added.push(t.id);
          else {
            try { changed.push({ id: t.id, oldPack: JSON.parse(oldSig) }); } catch {}
          }
        }
      }
    }
    if (lastSig.size) for (const id of lastSig.keys()) if (!next.has(id)) {
      deletions[id] = now;
      if (recordOps) removed.push(id);
    }
    lastSig = next;
    saveDeletions();
    if (recordOps) emitTaskOps(added, changed, removed, now);
  } else {
    lastSig = new Map(tasks.map((t) => [t.id, JSON.stringify(packTask(t))]));
  }
  LS.setItem(STORAGE_KEY, JSON.stringify(tasks));
  if (onTasksSaved) onTasksSaved();
}

function loadSettings() {
  try {
    return JSON.parse(LS.getItem(SETTINGS_KEY)) || {};
  } catch {
    return {};
  }
}

function saveSettings() {
  if (!applyingRemote) {
    settings.modified = Date.now();
    // v5：设置内容变了才记一条 settings op（modified 本身不参与比较）
    if (oplogActive()) {
      const sig = settingsContentSig();
      if (sig !== lastSettingsSig) {
        lastSettingsSig = sig;
        enqueueOp({ type: "settings", task_id: null, payload: settingsSubset(), client_ts: settings.modified });
      }
    }
  }
  LS.setItem(SETTINGS_KEY, JSON.stringify(settings));
  if (onTasksSaved) onTasksSaved();
}

/* ---------------- v4 同步数据层：删除墓碑 + 历史快照 ---------------- */
const DELETIONS_KEY = "todolist.deletions.v1";
const HISTORY_KEY = "todolist.history.v1";
const TOMBSTONE_TTL = 90 * 86400000; // 墓碑保留 90 天
let deletions = (() => {
  let d = {};
  try { d = JSON.parse(LS.getItem(DELETIONS_KEY)) || {}; } catch {}
  const cut = Date.now() - TOMBSTONE_TTL;
  for (const id in d) if (!(typeof d[id] === "number" && d[id] >= cut)) delete d[id];
  return d;
})();
function saveDeletions() {
  LS.setItem(DELETIONS_KEY, JSON.stringify(deletions));
}

let lastSig = new Map(tasks.map((t) => [t.id, JSON.stringify(packTask(t))]));
let applyingRemote = false;
let onTasksSaved = null; // 云同步模块注入：数据变更后调度自动推送
var getSyncStatus = null; // 云同步模块注入：查询同步状态

function normalizeTask(t) {
  return {
    id: t.id || uid(),
    title: String(t.title || "未命名任务"),
    // start: 开始日期 "YYYY-MM-DD"（任务从这天起出现在日程里）
    start: /^\d{4}-\d{2}-\d{2}$/.test(t.start) ? t.start : null,
    due: t.due || null,
    done: !!t.done,
    note: typeof t.note === "string" ? t.note : "",
    priority: ["high", "medium", "low"].includes(t.priority) ? t.priority : "none",
    tags: Array.isArray(t.tags) ? [...new Set(t.tags.filter(Boolean))] : [],
    repeat: ["daily", "weekly"].includes(t.repeat) ? t.repeat : "none",
    // repeatDays: 每周重复时选中的星期（0=周日 … 6=周六）
    repeatDays: Array.isArray(t.repeatDays)
      ? [...new Set(t.repeatDays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
      : [],
    // 排序序号（手动模式位置，跨端同步；旧数据加载时补）
    ord: typeof t.ord === "number" ? t.ord : null,
    createdAt: t.createdAt || Date.now(),
    // updatedAt: 最后修改时刻（v4 云同步合并依据），旧数据回退创建时间
    updatedAt: typeof t.updatedAt === "number" ? t.updatedAt : (typeof t.createdAt === "number" ? t.createdAt : Date.now()),
    // completedAt: 完成时刻（毫秒），用于让已完成任务保留在完成当天的栏目
    completedAt: typeof t.completedAt === "number" ? t.completedAt : null,
    // 重复任务链的内部记录：generatedFrom=由哪个任务生成；generatedNextId=完成时生成的下一期
    generatedFrom: t.generatedFrom || null,
    generatedNextId: t.generatedNextId || null,
  };
}

function uid() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/* ---------------- 工具函数 ---------------- */
const $ = (sel) => document.querySelector(sel);

const WEEKDAY_CN = ["日", "一", "二", "三", "四", "五", "六"];

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// "YYYY-MM-DDTHH:mm" 或 "YYYY-MM-DD" → "YYYY-MM-DD"
function dateKeyOf(dtStr) {
  return String(dtStr).slice(0, 10);
}

function shiftDateKey(key, delta) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d + delta);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

function dayLabel(key) {
  const [y, m, d] = key.split("-").map(Number);
  const wd = WEEKDAY_CN[new Date(y, m - 1, d).getDay()];
  const base = `${m}月${d}日 · 周${wd}`;
  if (key === todayKey()) return `今天 · ${base}`;
  if (key === shiftDateKey(todayKey(), 1)) return `明天 · ${base}`;
  if (key === shiftDateKey(todayKey(), -1)) return `昨天 · ${base}`;
  return `${y}年${base}`;
}

function isOverdue(task) {
  return !task.done && task.due && new Date(task.due).getTime() < Date.now();
}

function isDueToday(task) {
  if (task.done || !task.due || isOverdue(task)) return false;
  return dateKeyOf(task.due) === todayKey();
}

function pad(n) {
  return String(n).padStart(2, "0");
}

// 毫秒时间戳 → 本地 "YYYY-MM-DD"
function tsKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDue(due) {
  const d = new Date(due);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startDue = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((startDue - startToday) / 86400000);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (diffDays === 0) return `今天 ${time}`;
  if (diffDays === 1) return `明天 ${time}`;
  if (diffDays === -1) return `昨天 ${time}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

function toLocalInputValue(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 计算重复任务的下一期截止时间
function nextDue(dueStr, repeat, repeatDays) {
  const d = new Date(dueStr);
  if (repeat === "daily") {
    d.setDate(d.getDate() + 1);
  } else if (repeat === "weekly") {
    const days = repeatDays && repeatDays.length ? repeatDays : [d.getDay()];
    for (let i = 1; i <= 7; i++) {
      const c = new Date(d);
      c.setDate(d.getDate() + i);
      if (days.includes(c.getDay())) {
        d.setDate(d.getDate() + i);
        break;
      }
    }
  }
  return toLocalInputValue(d);
}

const PRIORITY_LABEL = { high: "高", medium: "中", low: "低", none: "无" };

function repeatLabel(t) {
  if (t.repeat === "daily") return "每日";
  if (t.repeat === "weekly") {
    const days = t.repeatDays.length
      ? t.repeatDays.map((d) => WEEKDAY_CN[d]).join("")
      : "?";
    return `每周${days}`;
  }
  return "";
}

let toastTimer = null;
function toast(msg, action) {
  const el = $("#toast");
  el.textContent = "";
  el.append(document.createTextNode(msg));
  if (action && action.fn) {
    const b = document.createElement("button");
    b.className = "toast-act";
    b.type = "button";
    b.textContent = action.label || "撤销";
    b.addEventListener("click", () => {
      el.classList.remove("show");
      action.fn();
    });
    el.append(b);
  }
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), action ? 8000 : 2600);
}

/* ---------------- 完成动效：音效 + 彩带 ---------------- */
let audioCtx = null;
function playCompleteSound() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const t0 = audioCtx.currentTime;
    // 轻快的上滑"啵"声
    const o1 = audioCtx.createOscillator();
    const g1 = audioCtx.createGain();
    o1.type = "triangle";
    o1.frequency.setValueAtTime(520, t0);
    o1.frequency.exponentialRampToValueAtTime(880, t0 + 0.08);
    g1.gain.setValueAtTime(0.1, t0);
    g1.gain.exponentialRampToValueAtTime(0.001, t0 + 0.18);
    o1.connect(g1).connect(audioCtx.destination);
    o1.start(t0);
    o1.stop(t0 + 0.2);
    // 高频"叮"的星光音
    const o2 = audioCtx.createOscillator();
    const g2 = audioCtx.createGain();
    o2.type = "sine";
    o2.frequency.setValueAtTime(1318, t0 + 0.06);
    g2.gain.setValueAtTime(0.0001, t0);
    g2.gain.setValueAtTime(0.07, t0 + 0.06);
    g2.gain.exponentialRampToValueAtTime(0.001, t0 + 0.38);
    o2.connect(g2).connect(audioCtx.destination);
    o2.start(t0 + 0.06);
    o2.stop(t0 + 0.42);
  } catch {}
}

const CONFETTI_COLORS = ["#4f6ef2", "#f59e0b", "#ef4444", "#10b981", "#8b5cf6", "#f43f5e"];

function burstConfetti(x, y) {
  const n = 14;
  for (let i = 0; i < n; i++) {
    const p = document.createElement("span");
    p.className = "confetti-piece";
    const angle = (Math.PI * 2 * i) / n + Math.random() * 0.6;
    const dist = 48 + Math.random() * 55;
    p.style.left = x + "px";
    p.style.top = y + "px";
    p.style.setProperty("--tx", Math.cos(angle) * dist + "px");
    p.style.setProperty("--ty", Math.sin(angle) * dist - 36 + "px");
    p.style.setProperty("--rot", Math.round(Math.random() * 540 - 270) + "deg");
    p.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    p.style.width = 5 + Math.random() * 3 + "px";
    p.style.height = 8 + Math.random() * 4 + "px";
    if (Math.random() < 0.4) p.style.borderRadius = "50%";
    p.style.animationDelay = Math.round(Math.random() * 60) + "ms";
    p.addEventListener("animationend", () => p.remove());
    document.body.appendChild(p);
  }
}

/* ---------------- 按天归属与筛选 ---------------- */
// 任务是否出现在 selectedDate 这一天的栏目里
function inSelectedDay(t) {
  const D = selectedDate;
  const s = t.start;
  const e = t.due ? dateKeyOf(t.due) : null;
  // 已完成的任务额外保留在"完成当天"的栏目里，不会点完就凭空消失
  const doneHere = t.done && t.completedAt && tsKey(t.completedAt) === D;
  if (!s && !e) return true; // 未安排日期的任务：每天都显示（列表末尾单独分组）
  if (s && !e) return t.done ? D === s || doneHere : D >= s; // 只有开始日期：从开始日起持续显示
  // 有截止时间（可能还有开始日期）
  const inWindow = s ? D >= s && D <= e : D === e;
  // 未完成且已过期的任务，额外显示在"今天"这一栏，避免被漏掉
  const overdueOnToday = !t.done && D === todayKey() && e < D;
  return inWindow || overdueOnToday || doneHere;
}

function matchTask(t) {
  // 搜索时跨所有日期查找，否则限定在当前日期栏
  if (!searchQuery && !inSelectedDay(t)) return false;
  switch (currentFilter) {
    case "active": if (t.done) return false; break;
    case "completed": if (!t.done) return false; break;
    case "overdue": if (!isOverdue(t)) return false; break;
  }
  if (activeTags.size && !t.tags.some((x) => activeTags.has(x))) return false;
  if (searchQuery) {
    const inTitle = t.title.toLowerCase().includes(searchQuery);
    const inNote = t.note.toLowerCase().includes(searchQuery);
    if (!inTitle && !inNote) return false;
  }
  return true;
}

const PRIORITY_WEIGHT = { high: 0, medium: 1, low: 2, none: 3 };

function sortedVisible() {
  const visible = tasks.filter(matchTask);
  if (settings.sortMode === "manual") return visible; // 保持数组顺序（自定义）
  if (settings.sortMode === "priority") {
    // 混合排序：优先级为主，截止时间为辅
    visible.sort((a, b) => {
      const w = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
      if (w !== 0) return w;
      if (a.due && b.due) return a.due.localeCompare(b.due);
      if (a.due) return -1;
      if (b.due) return 1;
      return b.createdAt - a.createdAt;
    });
    return visible;
  }
  // 默认：按截止时间由近到远，无截止时间排最后
  visible.sort((a, b) => {
    if (a.due && b.due) return a.due.localeCompare(b.due);
    if (a.due) return -1;
    if (b.due) return 1;
    return b.createdAt - a.createdAt;
  });
  return visible;
}

/* ---------------- 渲染 ---------------- */
const EDIT_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';
const TRASH_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const REPEAT_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>';

function render() {
  $("#dateLabelText").textContent = dayLabel(selectedDate);
  $("#todayBtn").classList.toggle("hidden", selectedDate === todayKey());
  renderList();
  renderCounts();
  renderTagChips();
  renderClearDoneBtn();
  checkReminders(); // 任务增删改后即时刷新到期提醒横幅
}

function renderList() {
  const list = $("#taskList");
  list.innerHTML = "";
  const visible = sortedVisible();
  $("#emptyState").classList.toggle("hidden", visible.length > 0);
  $(".empty-text").textContent = emptyText();
  // 有日期的任务在前，未安排日期的任务归到"未安排"分组
  const scheduled = visible.filter((t) => t.start || t.due);
  const unscheduled = visible.filter((t) => !t.start && !t.due);
  for (const t of scheduled) list.appendChild(renderTask(t));
  if (unscheduled.length > 0) {
    const div = document.createElement("li");
    div.className = "day-divider";
    div.textContent = "未安排日期";
    list.appendChild(div);
    for (const t of unscheduled) list.appendChild(renderTask(t));
  }
}

function emptyText() {
  if (searchQuery) return "没有匹配的任务";
  if (tasks.length === 0) return "还没有任务，点右下角 + 添加";
  if (activeTags.size) return `标签「${[...activeTags].join("、")}」下暂无任务`;
  switch (currentFilter) {
    case "active": return "这一天没有未完成的任务，干得漂亮";
    case "completed": return "这一天还没有已完成的任务";
    case "overdue": return "没有过期任务";
    default: return "这一天没有任务，切换日期看看";
  }
}

function renderCounts() {
  const dayTasks = tasks.filter(inSelectedDay);
  const counts = { all: dayTasks.length, active: 0, completed: 0, overdue: 0 };
  for (const t of dayTasks) {
    if (t.done) {
      counts.completed++;
    } else {
      counts.active++;
      if (isOverdue(t)) counts.overdue++;
    }
  }
  for (const [key, n] of Object.entries(counts)) {
    const el = $(`#filters [data-filter="${key}"] .count`);
    if (el) el.textContent = n;
  }
}

function renderTagChips() {
  const box = $("#tagChips");
  const btn = $("#tagToggleBtn");
  const tags = [...new Set(tasks.flatMap((t) => t.tags))].sort();
  for (const tag of [...activeTags]) if (!tags.includes(tag)) activeTags.delete(tag); // 标签已不存在
  btn.classList.toggle("disabled", tags.length === 0);
  btn.classList.toggle("on", tagsOpen || activeTags.size > 0);
  // 标签行按需出现：用户点开，或正在按标签筛选
  if (tags.length === 0 || (!tagsOpen && activeTags.size === 0)) {
    box.classList.add("hidden");
    box.classList.remove("collapsed");
    box.innerHTML = "";
    tagsExpanded = false;
    tagsOverflow = false;
    return;
  }
  box.classList.remove("hidden");
  box.classList.remove("collapsed");
  box.innerHTML = "";
  const label = document.createElement("span");
  label.className = "chip-label";
  label.textContent = "按标签筛选（可多选）：";
  box.appendChild(label);
  for (const tag of tags) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "tag-chip" + (activeTags.has(tag) ? " active" : "");
    chip.textContent = `# ${tag}`;
    chip.addEventListener("click", () => {
      if (activeTags.has(tag)) activeTags.delete(tag);
      else activeTags.add(tag);
      render();
    });
    box.appendChild(chip);
  }
  // 超过一行时折叠，提供展开/收起按钮
  if (!tagsExpanded) {
    box.classList.add("collapsed");
    tagsOverflow = box.scrollHeight > box.clientHeight + 4;
  }
  if (tagsOverflow) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "tag-toggle";
    toggle.textContent = tagsExpanded ? "收起 ▴" : "展开 ▾";
    toggle.addEventListener("click", () => {
      tagsExpanded = !tagsExpanded;
      renderTagChips();
    });
    box.appendChild(toggle);
  }
}

function renderClearDoneBtn() {
  const n = tasks.filter((t) => t.done && inSelectedDay(t)).length;
  const row = $("#clearDoneRow");
  if (row) row.classList.toggle("hidden", n === 0);
  $("#clearDoneCount").textContent = n > 0 ? `(${n})` : "";
}

function iconButton(kind, title) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `icon-btn icon-${kind}`;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = kind === "edit" ? EDIT_SVG : TRASH_SVG;
  return b;
}

function renderTask(t) {
  const li = document.createElement("li");
  li.className =
    "task-item" +
    (t.done ? " done" : "") +
    (isOverdue(t) ? " overdue" : "") +
    (t.priority !== "none" ? " p-" + t.priority : "");
  if (t.priority !== "none") li.title = `优先级：${PRIORITY_LABEL[t.priority]}`;
  li.dataset.id = t.id;
  li.draggable = true;

  // 完成复选框
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = "task-check";
  cb.checked = t.done;
  cb.title = t.done ? "标记为未完成" : "标记为完成";
  cb.setAttribute("aria-label", "标记完成");
  cb.addEventListener("change", () => toggleDone(t, cb.checked, cb));

  // 主体
  const main = document.createElement("div");
  main.className = "task-main";

  // 标题行（优先级用卡片左侧色条表达，见 CSS .p-*）
  const titleRow = document.createElement("div");
  titleRow.className = "task-title-row";
  const title = document.createElement("span");
  title.className = "task-title";
  title.textContent = t.title;
  titleRow.appendChild(title);

  // 元信息行：开始日期 + 截止时间 + 标签 + 重复
  const meta = document.createElement("div");
  meta.className = "task-meta";
  if (t.start && (!t.due || dateKeyOf(t.due) !== t.start)) {
    const st = document.createElement("span");
    st.className = "task-start";
    st.textContent = `自 ${t.start.slice(5)}`;
    st.title = `开始日期：${t.start}`;
    meta.appendChild(st);
  }
  const due = document.createElement("span");
  due.className = "task-due" + (t.due ? "" : " no-due");
  due.textContent = t.due ? formatDue(t.due) : "无截止时间";
  meta.appendChild(due);
  for (const tag of t.tags) {
    const pill = document.createElement("span");
    pill.className = "tag-pill";
    pill.textContent = tag;
    meta.appendChild(pill);
  }
  if (t.repeat !== "none") {
    const rp = document.createElement("span");
    rp.className = "repeat-pill";
    rp.innerHTML = REPEAT_SVG;
    rp.append(repeatLabel(t));
    rp.title = `重复：${repeatLabel(t)}，完成后自动生成下一期`;
    meta.appendChild(rp);
  }

  main.append(titleRow, meta);

  // 备注（有内容才显示，默认折叠一行）
  if (t.note) {
    const note = document.createElement("div");
    note.className = "task-note";
    note.textContent = t.note;
    note.title = "点击展开 / 折叠备注";
    note.addEventListener("click", () => note.classList.toggle("expanded"));
    main.appendChild(note);
  }

  // 操作按钮
  const actions = document.createElement("div");
  actions.className = "task-actions";
  const editBtn = iconButton("edit", "编辑");
  editBtn.addEventListener("click", () => openTaskModal(t.id));
  const delBtn = iconButton("trash", "删除");
  delBtn.addEventListener("click", () =>
    openConfirm("删除任务", `确定删除任务「${t.title}」吗？此操作不可恢复。`, () => {
      tasks = tasks.filter((x) => x.id !== t.id);
      if (dragId === t.id) dragId = null;
      saveTasks();
      render();
      toast("已删除任务");
    })
  );
  actions.append(editBtn, delBtn);

  // 拖拽排序
  li.addEventListener("dragstart", (e) => {
    if (settings.sortMode !== "manual") {
      settings.sortMode = "manual";
      saveSettings();
      $("#sortSelect").value = "manual";
      toast("已切换为自定义排序，可拖拽调整顺序");
    }
    dragId = t.id;
    li.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try {
      e.dataTransfer.setData("text/plain", t.id);
    } catch {}
  });
  li.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!dragId || li.dataset.id === dragId) return;
    const rect = li.getBoundingClientRect();
    const before = e.clientY - rect.top < rect.height / 2;
    markDropTarget(li, before);
    dropPos = { id: li.dataset.id, before };
  });
  li.addEventListener("drop", (e) => {
    e.preventDefault();
    commitDrop();
  });
  li.addEventListener("dragend", () => {
    li.classList.remove("dragging");
    clearDropMarkers();
    commitDrop();
    dragId = null;
  });

  li.append(cb, main, actions);
  return li;
}

// 容器级兜底：拖到任务间隙 / 列表末尾时，li 上的 drop 不会触发，由 ul 接收
$("#taskList").addEventListener("dragover", (e) => e.preventDefault());
$("#taskList").addEventListener("drop", (e) => {
  e.preventDefault();
  commitDrop();
});

// 拖拽落点视觉指示线
function clearDropMarkers() {
  for (const el of document.querySelectorAll(".drop-above, .drop-below")) {
    el.classList.remove("drop-above", "drop-below");
  }
}

function markDropTarget(li, before) {
  clearDropMarkers();
  li.classList.add(before ? "drop-above" : "drop-below");
}

// 松手时按记录的落点直接重排 tasks 数组（幂等：drop / dragend 先后触发安全）
function commitDrop() {
  const pos = dropPos;
  dropPos = null;
  if (!dragId || !pos) return;
  const from = tasks.findIndex((x) => x.id === dragId);
  if (from === -1) return;
  const [moved] = tasks.splice(from, 1);
  let to = tasks.findIndex((x) => x.id === pos.id);
  if (to === -1) {
    tasks.splice(from, 0, moved);
    return;
  }
  if (!pos.before) to++;
  tasks.splice(to, 0, moved);
  tasks.forEach((x, i) => { x.ord = i; }); // 重排后统一编号，签名 diff 只给位置变化的任务盖时间戳
  saveTasks();
  render();
}

// 新任务的排序序号：排最后
function nextOrd() {
  let m = -1;
  for (const t of tasks) if (typeof t.ord === "number" && t.ord > m) m = t.ord;
  return m + 1;
}

/* ---------------- 完成切换 & 重复任务 ---------------- */
function toggleDone(t, done, cb) {
  // 记录复选框位置，用于完成时的彩带动效
  let fx = null;
  if (done && cb) {
    const r = cb.getBoundingClientRect();
    fx = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  t.done = done;
  t.completedAt = done ? Date.now() : null;

  if (done && t.repeat !== "none") {
    // 历史数据可能存在没有截止时间的重复任务：以今天 23:59 为锚点生成下一期
    let anchor = t.due;
    if (!anchor) {
      const d = new Date();
      d.setHours(23, 59, 0, 0);
      anchor = toLocalInputValue(d);
    }
    // 幂等生成：本期完成生成的"下一期"已存在时不再重复生成，
    // 防止反复勾选/取消堆积出多个相同副本
    if (!t.generatedNextId || !tasks.find((x) => x.id === t.generatedNextId)) {
      const nextDueStr = nextDue(anchor, t.repeat, t.repeatDays);
      const next = normalizeTask({
        ...t,
        id: uid(),
        due: nextDueStr,
        // 新一期出现在它自己的截止日期那一栏
        start: t.start ? dateKeyOf(nextDueStr) : null,
        done: false,
        completedAt: null,
        createdAt: Date.now(),
        ord: nextOrd(),
        generatedFrom: t.id,
        generatedNextId: null,
      });
      tasks.push(next);
      t.generatedNextId = next.id;
      toast(`已生成下一期：${next.title}（${formatDue(next.due)}）`);
    }
  }

  // 取消完成时，撤回由本次完成生成的"下一期"（它还没被完成），避免堆积
  if (!done && t.generatedNextId) {
    const gen = tasks.find((x) => x.id === t.generatedNextId);
    if (gen && !gen.done) {
      tasks = tasks.filter((x) => x.id !== gen.id);
      toast("已撤回自动生成的下一期");
    }
    t.generatedNextId = null;
  }

  saveTasks();
  render();

  // 完成瞬间：音效 + 彩带 + 弹跳划线动效
  if (done) {
    if (settings.sound !== false) playCompleteSound();
    if (fx) burstConfetti(fx.x, fx.y);
    const li = document.querySelector(`.task-item[data-id="${CSS.escape(t.id)}"]`);
    if (li) {
      li.classList.add("celebrate");
      setTimeout(() => li.classList.remove("celebrate"), 600);
    }
  }
}

/* ---------------- 新建 / 编辑弹窗 ---------------- */
function openTaskModal(id = null) {
  editingId = id;
  const t = id ? tasks.find((x) => x.id === id) : null;
  $("#modalTitle").textContent = id ? "编辑任务" : "新建任务";
  $("#submitBtn").textContent = id ? "保存修改" : "创建";
  $("#taskTitleInput").value = t ? t.title : "";
  $("#taskStartInput").value = t && t.start ? t.start : "";
  $("#taskDueDateInput").value = t && t.due ? dateKeyOf(t.due) : "";
  $("#taskDueTimeInput").value = t && t.due ? t.due.slice(11, 16) : "";
  $("#taskPriorityInput").value = t ? t.priority : "none";
  $("#taskRepeatInput").value = t ? t.repeat : "none";
  $("#taskTagsInput").value = t ? t.tags.join(", ") : "";
  $("#taskNoteInput").value = t ? t.note : "";
  syncWeekdayPicker(t ? t.repeatDays : []);
  toggleRepeatDaysField();
  hideTitleError();
  $("#repeatDaysError").classList.add("hidden");
  $("#taskModal").classList.remove("hidden");
  $("#taskTitleInput").focus();
}

function closeTaskModal() {
  $("#taskModal").classList.add("hidden");
  closeDatePicker();
  closeTimePicker();
  editingId = null;
}

function showTitleError(msg) {
  const el = $("#titleError");
  el.textContent = msg;
  el.classList.remove("hidden");
  $("#taskTitleInput").classList.add("invalid");
}

function hideTitleError() {
  $("#titleError").classList.add("hidden");
  $("#taskTitleInput").classList.remove("invalid");
}

/* 每周重复日选择器 */
function toggleRepeatDaysField() {
  const isWeekly = $("#taskRepeatInput").value === "weekly";
  $("#repeatDaysField").classList.toggle("hidden", !isWeekly);
  // 刚切到每周且未勾选任何一天时，按截止时间所在星期预勾选
  if (isWeekly && readWeekdayPicker().length === 0) {
    const dueVal = $("#taskDueDateInput").value;
    const day = dueVal
      ? new Date(`${dueVal}T00:00:00`).getDay()
      : new Date().getDay();
    const btn = $(`#weekdayPicker [data-day="${day}"]`);
    if (btn) btn.classList.add("on");
  }
}

function readWeekdayPicker() {
  return [...document.querySelectorAll("#weekdayPicker .on")]
    .map((b) => Number(b.dataset.day))
    .sort((a, b) => a - b);
}

function syncWeekdayPicker(days) {
  for (const b of document.querySelectorAll("#weekdayPicker button")) {
    b.classList.toggle("on", days.includes(Number(b.dataset.day)));
  }
}

$("#weekdayPicker").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-day]");
  if (!b) return;
  b.classList.toggle("on");
  $("#repeatDaysError").classList.add("hidden");
});

$("#taskRepeatInput").addEventListener("change", toggleRepeatDaysField);

$("#taskForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const title = $("#taskTitleInput").value.trim();
  if (!title) {
    showTitleError("任务名称不能为空");
    $("#taskTitleInput").focus();
    return;
  }
  const start = $("#taskStartInput").value || null;
  const dueDate = $("#taskDueDateInput").value;
  const dueTime = $("#taskDueTimeInput").value;
  if (!dueDate && dueTime) {
    toast("请先选择截止日期");
    return;
  }
  // 只选日期未选时间时，默认当天 23:59 截止
  const due = dueDate ? `${dueDate}T${dueTime || "23:59"}` : null;
  if (start && due && start > dateKeyOf(due)) {
    toast("开始日期不能晚于截止日期");
    $("#taskStartInput").focus();
    return;
  }
  const note = $("#taskNoteInput").value.trim();
  const priority = $("#taskPriorityInput").value;
  const repeat = $("#taskRepeatInput").value;
  const repeatDays = repeat === "weekly" ? readWeekdayPicker() : [];
  if (repeat === "weekly" && repeatDays.length === 0) {
    $("#repeatDaysError").classList.remove("hidden");
    return;
  }
  // 重复任务必须有截止时间，否则完成后无法推算下一期
  if (repeat !== "none" && !dueDate) {
    toast("重复任务需要设置截止日期");
    return;
  }
  const tags = [
    ...new Set(
      $("#taskTagsInput").value
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean)
    ),
  ];

  if (editingId) {
    const t = tasks.find((x) => x.id === editingId);
    Object.assign(t, { title, start, due, note, priority, repeat, repeatDays, tags });
  } else {
    tasks.push(
      normalizeTask({
        id: uid(),
        title,
        start,
        due,
        note,
        priority,
        repeat,
        repeatDays,
        tags,
        createdAt: Date.now(),
        ord: nextOrd(),
      })
    );
  }
  saveTasks();
  closeTaskModal();
  render();
});

$("#taskTitleInput").addEventListener("input", hideTitleError);
$("#addTaskBtn").addEventListener("click", () => openTaskModal());
$("#cancelTaskModal").addEventListener("click", closeTaskModal);

/* ---------------- 通用确认弹窗 ---------------- */
function openConfirm(title, text, cb, yesLabel = "删除") {
  $("#confirmTitle").textContent = title;
  $("#confirmText").textContent = text;
  $("#confirmYes").textContent = yesLabel;
  confirmCallback = cb;
  $("#confirmModal").classList.remove("hidden");
}

function closeConfirmModal() {
  $("#confirmModal").classList.add("hidden");
  confirmCallback = null;
}

$("#confirmYes").addEventListener("click", () => {
  const cb = confirmCallback;
  closeConfirmModal();
  if (cb) cb();
});
$("#confirmNo").addEventListener("click", closeConfirmModal);

/* ---------------- 日期切换栏 + 小日历 ---------------- */
function shiftDay(delta) {
  selectedDate = shiftDateKey(selectedDate, delta);
  calMonth = new Date(`${selectedDate}T00:00:00`);
  render();
}

$("#prevDayBtn").addEventListener("click", () => shiftDay(-1));
$("#nextDayBtn").addEventListener("click", () => shiftDay(1));
$("#todayBtn").addEventListener("click", () => {
  selectedDate = todayKey();
  calMonth = new Date();
  render();
});

function closeCalendar() {
  $("#calendarPop").classList.add("hidden");
}

$("#dateLabelBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  const pop = $("#calendarPop");
  if (pop.classList.contains("hidden")) {
    calMonth = new Date(`${selectedDate}T00:00:00`);
    renderCalendar();
    pop.classList.remove("hidden");
  } else {
    pop.classList.add("hidden");
  }
});

document.addEventListener("mousedown", (e) => {
  const pop = $("#calendarPop");
  if (pop.classList.contains("hidden")) return;
  if (!pop.contains(e.target) && !$("#dateLabelBtn").contains(e.target)) closeCalendar();
});

// 哪些日期上有任务（用于日历小圆点）
function taskDayMarks() {
  const marks = new Set();
  for (const t of tasks) {
    if (t.start) marks.add(t.start);
    if (t.due) marks.add(dateKeyOf(t.due));
  }
  return marks;
}

function renderCalendar() {
  const pop = $("#calendarPop");
  pop.innerHTML = "";
  const y = calMonth.getFullYear();
  const m = calMonth.getMonth();

  const head = document.createElement("div");
  head.className = "cal-head";
  const prevM = document.createElement("button");
  prevM.type = "button";
  prevM.className = "cal-nav";
  prevM.setAttribute("aria-label", "上个月");
  prevM.textContent = "‹";
  prevM.addEventListener("click", () => {
    calMonth = new Date(y, m - 1, 1);
    renderCalendar();
  });
  const title = document.createElement("span");
  title.className = "cal-title";
  title.textContent = `${y}年${m + 1}月`;
  const nextM = document.createElement("button");
  nextM.type = "button";
  nextM.className = "cal-nav";
  nextM.setAttribute("aria-label", "下个月");
  nextM.textContent = "›";
  nextM.addEventListener("click", () => {
    calMonth = new Date(y, m + 1, 1);
    renderCalendar();
  });
  head.append(prevM, title, nextM);

  const grid = document.createElement("div");
  grid.className = "cal-grid";
  for (const wd of WEEKDAY_CN) {
    const dow = document.createElement("span");
    dow.className = "cal-dow";
    dow.textContent = wd;
    grid.appendChild(dow);
  }

  const marks = taskDayMarks();
  const tKey = todayKey();
  const startDow = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  for (let i = 0; i < startDow; i++) {
    const blank = document.createElement("span");
    blank.className = "cal-cell blank";
    grid.appendChild(blank);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${y}-${pad(m + 1)}-${pad(d)}`;
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "cal-cell";
    cell.textContent = d;
    if (key === tKey) cell.classList.add("today");
    if (key === selectedDate) cell.classList.add("selected");
    if (marks.has(key)) cell.classList.add("has-task");
    cell.addEventListener("click", () => {
      selectedDate = key;
      closeCalendar();
      render();
    });
    grid.appendChild(cell);
  }

  pop.append(head, grid);
}

/* ---------------- 表单日期选择器（复用首页小日历样式） ---------------- */
let dpMonth = new Date();
let dpTarget = null; // 当前回填的输入框
let tpTarget = null; // 当前回填的时间输入框
let tpH = null;      // 时间选择器：时
let tpM = null;      // 时间选择器：分

function openDatePicker(input) {
  closeTimePicker();
  dpTarget = input;
  dpMonth = input.value ? new Date(`${input.value}T00:00:00`) : new Date();
  renderDatePicker();
  const pop = $("#datePickerPop");
  pop.classList.remove("hidden");
  const r = input.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 292))}px`;
  pop.style.top = `${r.bottom + 6}px`;
}

function closeDatePicker() {
  $("#datePickerPop").classList.add("hidden");
  dpTarget = null;
}

function renderDatePicker() {
  const pop = $("#datePickerPop");
  pop.innerHTML = "";
  const y = dpMonth.getFullYear();
  const m = dpMonth.getMonth();

  const head = document.createElement("div");
  head.className = "cal-head";
  const prevM = document.createElement("button");
  prevM.type = "button";
  prevM.className = "cal-nav";
  prevM.setAttribute("aria-label", "上个月");
  prevM.textContent = "\u2039";
  // 禁止翻到早于当前月（以系统本地日期为准）
  const nowRef = new Date();
  if (y === nowRef.getFullYear() && m === nowRef.getMonth()) {
    prevM.disabled = true;
    prevM.classList.add("cal-nav-off");
  }
  prevM.addEventListener("click", () => {
    dpMonth = new Date(y, m - 1, 1);
    renderDatePicker();
  });
  const title = document.createElement("span");
  title.className = "cal-title";
  title.textContent = `${y}\u5e74${m + 1}\u6708`;
  const nextM = document.createElement("button");
  nextM.type = "button";
  nextM.className = "cal-nav";
  nextM.setAttribute("aria-label", "下个月");
  nextM.textContent = "\u203a";
  nextM.addEventListener("click", () => {
    dpMonth = new Date(y, m + 1, 1);
    renderDatePicker();
  });
  head.append(prevM, title, nextM);

  const grid = document.createElement("div");
  grid.className = "cal-grid";
  for (const wd of WEEKDAY_CN) {
    const dow = document.createElement("span");
    dow.className = "cal-dow";
    dow.textContent = wd;
    grid.appendChild(dow);
  }

  const tKey = todayKey();
  const selKey = dpTarget ? dpTarget.value : "";
  const startDow = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  for (let i = 0; i < startDow; i++) {
    const blank = document.createElement("span");
    blank.className = "cal-cell blank";
    grid.appendChild(blank);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${y}-${pad(m + 1)}-${pad(d)}`;
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "cal-cell";
    cell.textContent = d;
    if (key === tKey) cell.classList.add("today");
    if (key === selKey) cell.classList.add("selected");
    // 禁止选择早于系统当天的日期
    if (key < tKey) {
      cell.disabled = true;
      cell.classList.add("cal-cell-off");
    } else {
      cell.addEventListener("click", () => {
        if (dpTarget) dpTarget.value = key;
        closeDatePicker();
      });
    }
    grid.appendChild(cell);
  }

  pop.append(head, grid);
}

/* ---------------- 表单时间选择器（滚轮滑动式） ---------------- */
const TIME_OPT_H = 36; // 单个选项高度（与 CSS .tp-opt 保持同步）
let tpDirty = false;   // 本次打开后用户是否真正滑动过（防止初始定位误提交）

function openTimePicker(input) {
  closeDatePicker();
  tpTarget = input;
  const v = input.value;
  tpH = v ? Number(v.slice(0, 2)) : null;
  tpM = v ? Number(v.slice(3, 5)) : null;
  tpDirty = false;
  renderTimePicker();
  const pop = $("#timePickerPop");
  pop.classList.remove("hidden");
  const r = input.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 276))}px`;
  pop.style.top = `${r.bottom + 6}px`;
  // 定位到当前值（须在可见后设置，display:none 时无布局高度）
  const wheels = pop.querySelectorAll(".tp-wheel");
  wheels[0].scrollTop = (tpH ?? 12) * TIME_OPT_H;
  wheels[1].scrollTop = (tpM ?? 0) * TIME_OPT_H;
}

function closeTimePicker() {
  $("#timePickerPop").classList.add("hidden");
  tpTarget = null;
}

function writeTimeValue() {
  if (tpTarget) tpTarget.value = `${pad(tpH ?? 12)}:${pad(tpM ?? 0)}`;
}

function renderTimePicker() {
  const pop = $("#timePickerPop");
  pop.innerHTML = "";

  const head = document.createElement("div");
  head.className = "tp-head";
  const title = document.createElement("span");
  title.className = "tp-title";
  title.textContent = "选择时间";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "tp-clear";
  clear.textContent = "清空";
  clear.addEventListener("click", () => {
    if (tpTarget) tpTarget.value = "";
    closeTimePicker();
  });
  head.append(title, clear);

  const cols = document.createElement("div");
  cols.className = "tp-cols";
  const mkCol = (labelText, count, isHour) => {
    const col = document.createElement("div");
    col.className = "tp-col";
    const lab = document.createElement("span");
    lab.className = "tp-col-label";
    lab.textContent = labelText;

    const wrap = document.createElement("div");
    wrap.className = "tp-wheel-wrap";
    const band = document.createElement("div");
    band.className = "tp-band";
    const wheel = document.createElement("div");
    wheel.className = "tp-wheel";
    for (let i = 0; i < count; i++) {
      const opt = document.createElement("div");
      opt.className = "tp-opt" + ((isHour ? tpH : tpM) === i ? " on" : "");
      opt.textContent = pad(i);
      wheel.appendChild(opt);
    }

    // 滑动过程中实时高亮居中的选项
    const highlight = (idx) => {
      for (let i = 0; i < wheel.children.length; i++) {
        wheel.children[i].classList.toggle("on", i === idx);
      }
    };
    let timer = null;
    wheel.addEventListener("scroll", () => {
      const idx = Math.max(0, Math.min(count - 1, Math.round(wheel.scrollTop / TIME_OPT_H)));
      highlight(idx);
      // 停稳后提交（tpDirty 过滤打开时的程序化滚动）
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!tpDirty) return;
        if (isHour) tpH = idx;
        else tpM = idx;
        writeTimeValue();
      }, 130);
    });
    wheel.addEventListener("pointerdown", () => (tpDirty = true));
    wheel.addEventListener("wheel", () => (tpDirty = true));

    wrap.append(band, wheel);
    col.append(lab, wrap);
    return col;
  };
  cols.append(mkCol("时", 24, true), mkCol("分", 60, false));
  pop.append(head, cols);
}

for (const sel of ["#taskStartInput", "#taskDueDateInput"]) {
  $(sel).addEventListener("click", () => {
    const input = $(sel);
    const pop = $("#datePickerPop");
    if (!pop.classList.contains("hidden") && dpTarget === input) {
      closeDatePicker();
    } else {
      openDatePicker(input);
    }
  });
}

$("#taskDueTimeInput").addEventListener("click", () => {
  const input = $("#taskDueTimeInput");
  const pop = $("#timePickerPop");
  if (!pop.classList.contains("hidden") && tpTarget === input) {
    closeTimePicker();
  } else {
    openTimePicker(input);
  }
});

document.addEventListener("mousedown", (e) => {
  const dpPop = $("#datePickerPop");
  if (
    !dpPop.classList.contains("hidden") &&
    !dpPop.contains(e.target) &&
    e.target !== $("#taskStartInput") &&
    e.target !== $("#taskDueDateInput")
  ) {
    closeDatePicker();
  }
  const tpPop = $("#timePickerPop");
  if (
    !tpPop.classList.contains("hidden") &&
    !tpPop.contains(e.target) &&
    e.target !== $("#taskDueTimeInput")
  ) {
    closeTimePicker();
  }
});

/* ---------------- 设置弹窗 ---------------- */
function openSettingsModal() {
  $("#setSound").checked = settings.sound !== false;
  $("#setNotify").checked = settings.notifications !== false;
  $("#setCloseBehavior").value = settings.closeBehavior === "quit" ? "quit" : "tray";
  renderStyleSeg();
  renderAccentSwatches();
  if (ELECTRON) {
    $("#electronOnlyFields").classList.remove("hidden");
    ELECTRON.getVersion().then((v) => {
      $("#versionInfo").textContent =
        `待办清单 v${v.app} · Electron ${v.electron} · Chromium ${v.chrome} · Node ${v.node}`;
    });
  } else {
    $("#electronOnlyFields").classList.add("hidden");
    $("#versionInfo").textContent = "待办清单 v1.1.0（Web 版 · 浏览器模式，托盘与桌面通知不可用）";
  }
  $("#settingsModal").classList.remove("hidden");
}

function closeSettingsModal() {
  $("#settingsModal").classList.add("hidden");
}

$("#settingsBtn").addEventListener("click", openSettingsModal);
$("#closeSettingsBtn").addEventListener("click", closeSettingsModal);

/* ---------------- 账户中心（华为登录 / 匿名体验；云端接入后替换存储层即可） ---------------- */
const ACCOUNTS_KEY = "todolist_accounts";
const SESSION_KEY = "todolist_session";
const ANON_KEY = "anonymous";

function loadAccounts() {
  try {
    return JSON.parse(LS.getItem(ACCOUNTS_KEY)) || {};
  } catch {
    return {};
  }
}
function saveAccounts(a) {
  LS.setItem(ACCOUNTS_KEY, JSON.stringify(a));
}
function currentUser() {
  const key = LS.getItem(SESSION_KEY);
  if (!key) return null;
  const acc = loadAccounts()[key];
  if (!acc) return null;
  return {
    key,
    name: acc.name || key,
    provider: acc.provider || "",
    createdAt: acc.createdAt,
    // 陪伴起点唯一来源：云端 profiles.first_at（登录/启动时随会话缓存，本地不独立存储）
    cloudFirstAt: (acc.sb && acc.sb.cloudFirstAt) || 0,
    avatar: (acc.sb && acc.sb.avatar) || "",
  };
}

function renderAccountModal() {
  const user = currentUser();
  $("#accountGuest").classList.toggle("hidden", !!user);
  $("#accountUser").classList.toggle("hidden", !user);
  if (user) {
    // 头像：云端有华为头像则显示图片，否则回退名字首字母
    const avEl = $("#acctAvatar");
    if (user.avatar) {
      avEl.textContent = "";
      avEl.style.backgroundImage = `url("${user.avatar}")`;
      avEl.classList.add("has-img");
    } else {
      avEl.classList.remove("has-img");
      avEl.style.backgroundImage = "";
      avEl.textContent = (user.name || user.key).trim().charAt(0).toUpperCase();
    }
    // 旧版本创建的匿名账户名沿用显示为「匿名用户」
    $("#acctNick").textContent = user.name === "匿名旅人" ? "匿名用户" : user.name;
    // 与鸿蒙版一致：账户副标题展示 UID 前 12 位（key 格式 hwid:openID / ggl:sub）
    $("#acctMail").textContent =
      user.provider === "hwid"
        ? "华为账号 · UID: " + user.key.slice(5, 17)
        : user.provider === "google"
          ? "谷歌账号 · UID: " + user.key.slice(4, 16)
          : user.provider === "anon" ? "匿名体验" : "本地账户";
    $("#acctStatTasks").textContent = tasks.length;
    $("#acctStatDone").textContent = tasks.filter((t) => t.done).length;
    // 陪伴天数只认云端起点；无云端起点（匿名/未连云）隐藏该栏（同鸿蒙版）
    $("#acctStatDays").closest(".acct-stat").classList.toggle("hidden", !user.cloudFirstAt);
    if (user.cloudFirstAt) {
      $("#acctStatDays").textContent = Math.max(1, Math.ceil((Date.now() - user.cloudFirstAt) / 86400000));
    }
    // 云服务状态：华为/谷歌账号且已建立 Supabase 会话时自动同步生效
    const acc = loadAccounts()[user.key] || {};
    const hasCloud = ["hwid", "google"].includes(user.provider) && acc.sb && acc.sb.userId;
    const st = getSyncStatus ? getSyncStatus() : { pending: false, busy: false, connected: false };
    $("#cloudSyncBadge").classList.toggle("on", !!hasCloud);
    $("#cloudSyncBadge").textContent = hasCloud ? "已连接" : "待开启";
    $("#cloudSyncDesc").textContent = !hasCloud
      ? ["hwid", "google"].includes(user.provider)
        ? "云端会话未建立，重新登录可重试"
        : "登录华为/谷歌账号后自动开启云同步"
      : st.busy
        ? "同步中…"
        : st.pending
          ? "有改动待推送…"
          : acc.lastSyncMs
            ? "自动同步 · 上次 " + new Date(acc.lastSyncMs).toLocaleString()
            : "自动同步已开启，等待首次同步";
  }
  // 图标保持常态（与设置一致，悬停才高亮）；登录状态通过悬浮提示体现
  $("#accountBtn").classList.remove("on");
  $("#accountBtn").title = user ? `账户中心 · ${user.name}` : "账户中心";
}

function openAccountModal() {
  renderAccountModal();
  $("#accountModal").classList.remove("hidden");
}
function closeAccountModal() {
  $("#accountModal").classList.add("hidden");
}

$("#accountBtn").addEventListener("click", openAccountModal);
document
  .querySelectorAll("[data-close-account]")
  .forEach((b) => b.addEventListener("click", closeAccountModal));
$("#accountModal").addEventListener("click", (e) => {
  if (e.target === $("#accountModal")) closeAccountModal();
});

// 匿名体验：进入游客身份（同样拥有陪伴起点，后续登录华为账号可升级接续）
$("#anonEnterBtn").addEventListener("click", () => {
  const accounts = loadAccounts();
  if (!accounts[ANON_KEY]) {
    accounts[ANON_KEY] = { name: "匿名用户", provider: "anon", createdAt: Date.now() };
    saveAccounts(accounts);
  }
  LS.setItem(SESSION_KEY, ANON_KEY);
  closeAccountModal();
  renderAccountModal();
  toast("已进入匿名模式，随时可在账户中心登录华为账号");
});

$("#logoutBtn").addEventListener("click", () => {
  openConfirm(
    "退出登录",
    "退出账号会清除本地存档，云端数据不受影响。确定退出？",
    () => {
      // 先掐断一切自动同步：退出过程中绝不允许任何网络操作
      stopRealtime();
      clearTimeout(pushTimer);
      clearTimeout(remoteTimer);
      cloudPending = false;
      cloudBusy = false;
      const cur = currentUser();
      const accounts = loadAccounts();
      const acc = cur ? accounts[cur.key] : null;
      const connected = cur && ["hwid", "google"].includes(cur.provider) && acc && acc.sb;
      if (acc) {
        delete acc.sb;
        delete acc.lastSyncMs;
        delete acc.v5Migrated;
        saveAccounts(accounts);
      }
      resetOplogLocal(); // 游标/去重环/outbox 跟着账号走，退出即清空
      LS.removeItem(SESSION_KEY);
      if (connected) {
        // 数据跟着账户走：本地任务清空（不记墓碑、不触发推送），重新登录后自动同步回来
        applyingRemote = true;
        tasks = [];
        saveTasks();
        applyingRemote = false;
        render(); // 任务已空，提醒横幅随 render 自动收起
      }
      renderAccountModal();
      toast("已退出登录");
    },
    "退出"
  );
});

renderAccountModal();

$("#setSound").addEventListener("change", (e) => {
  settings.sound = e.target.checked;
  saveSettings();
});

$("#setNotify").addEventListener("change", (e) => {
  settings.notifications = e.target.checked;
  saveSettings();
});

$("#setCloseBehavior").addEventListener("change", (e) => {
  settings.closeBehavior = e.target.value;
  saveSettings();
  if (ELECTRON) ELECTRON.cfgSet("closeBehavior", e.target.value);
});

/* ---------------- 弹窗通用关闭 ---------------- */
const MODAL_CLOSE = {
  taskModal: closeTaskModal,
  confirmModal: closeConfirmModal,
  settingsModal: closeSettingsModal,
};

for (const id of Object.keys(MODAL_CLOSE)) {
  document.getElementById(id).addEventListener("mousedown", (e) => {
    if (e.target === e.currentTarget) MODAL_CLOSE[id]();
  });
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  closeCalendar();
  closeDatePicker();
  closeTimePicker();
  for (const id of Object.keys(MODAL_CLOSE)) {
    if (!document.getElementById(id).classList.contains("hidden")) {
      MODAL_CLOSE[id]();
    }
  }
});

/* ---------------- 筛选切换 ---------------- */
function setFilter(filter) {
  currentFilter = filter;
  $("#filters .active").classList.remove("active");
  $(`#filters [data-filter="${filter}"]`).classList.add("active");
  render();
}

$("#filters").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-filter]");
  if (!btn || btn.classList.contains("active")) return;
  setFilter(btn.dataset.filter);
});

/* ---------------- 搜索 ---------------- */
$("#searchInput").addEventListener("input", (e) => {
  searchQuery = e.target.value.trim().toLowerCase();
  render();
});

$("#searchToggleBtn").addEventListener("click", () => {
  const row = $("#searchRow");
  const show = row.classList.contains("hidden");
  row.classList.toggle("hidden", !show);
  $("#searchToggleBtn").classList.toggle("on", show);
  if (show) {
    $("#searchInput").focus();
  } else if (searchQuery) {
    $("#searchInput").value = "";
    searchQuery = "";
    render();
  }
});

/* ---------------- 标签行开合（点标签图标展开，收起时清除筛选） ---------------- */
$("#tagToggleBtn").addEventListener("click", () => {
  tagsOpen = !tagsOpen;
  if (!tagsOpen) activeTags.clear();
  render();
});

/* ---------------- 排序方式 ---------------- */
$("#sortSelect").addEventListener("change", (e) => {
  settings.sortMode = e.target.value;
  saveSettings();
  render();
  if (settings.sortMode === "manual") toast("自定义排序：直接拖拽任务调整顺序");
});

/* ---------------- 批量清理已完成（当前日期栏） ---------------- */
$("#clearDoneBtn").addEventListener("click", () => {
  const n = tasks.filter((t) => t.done && inSelectedDay(t)).length;
  if (n === 0) return;
  openConfirm(
    "批量清理",
    `确定删除这一天中全部 ${n} 条已完成的任务吗？此操作不可恢复。`,
    () => {
      tasks = tasks.filter((t) => !(t.done && inSelectedDay(t)));
      saveTasks();
      render();
      toast(`已清理 ${n} 条已完成任务`);
    },
    "清理"
  );
});

/* ---------------- 主题风格 / 主题色 / 深浅色 ---------------- */
// 两套风格各自的色板：things=单强调色（浅/深各一版），soft=渐变双色
const ACCENT_PALETTES = {
  things: [
    { id: "blue", name: "蓝色", light: "#5a7bd6", dark: "#8aa6e8" },
    { id: "indigo", name: "靛蓝", light: "#6b62d6", dark: "#9a92ec" },
    { id: "purple", name: "紫色", light: "#a05fc8", dark: "#c08ee0" },
    { id: "pink", name: "粉色", light: "#d162a4", dark: "#e893c6" },
    { id: "red", name: "红色", light: "#d65a5a", dark: "#e88f8f" },
    { id: "orange", name: "橙色", light: "#dd8544", dark: "#eab07c", ink: true },
    { id: "yellow", name: "黄色", light: "#c99a2e", dark: "#e3c375", ink: true },
    { id: "green", name: "绿色", light: "#5aa06b", dark: "#92c7a1" },
    { id: "teal", name: "青色", light: "#46a3a8", dark: "#83c8cc" },
    { id: "brown", name: "棕色", light: "#9c7a55", dark: "#c2a179" },
  ],
  soft: [
    { id: "violet", name: "紫蓝", l: ["#6c7ff5", "#a78bfa"], d: ["#8b9bff", "#b79bfa"] },
    { id: "sunset", name: "粉橙", l: ["#f06292", "#ff9e57"], d: ["#ff8fb0", "#ffb97a"] },
    { id: "ocean", name: "蓝青", l: ["#4aa3f0", "#34d1c0"], d: ["#6cb8f5", "#5fe3d2"] },
    { id: "mint", name: "薄荷", l: ["#2fbf87", "#6fd06f"], d: ["#4ad4a4", "#8fe38f"] },
    { id: "amber", name: "琥珀", l: ["#f5a623", "#f7c948"], d: ["#fbbf5f", "#ffd97a"], ink: true },
    { id: "rose", name: "玫红", l: ["#ef5f7e", "#e26bc0"], d: ["#ff7d95", "#f08fd0"] },
  ],
};

function currentPalette() {
  return ACCENT_PALETTES[settings.style] || ACCENT_PALETTES.things;
}

// 云同步校验用：两套色板的全部合法强调色 id
const VALID_ACCENTS = new Set(
  [...ACCENT_PALETTES.things, ...ACCENT_PALETTES.soft].map((c) => c.id)
);

// 把所选主题色注入 CSS 变量（--accent / --accent2 / --grad），全局联动
function applyStyle() {
  const root = document.documentElement;
  root.dataset.style = settings.style;
  const pal = currentPalette();
  const c = pal.find((x) => x.id === settings.accent) || pal[0];
  settings.accent = c.id;
  const dark = settings.theme === "dark";
  if (settings.style === "things") {
    const a = dark ? c.dark : c.light;
    root.style.setProperty("--accent", a);
    root.style.setProperty("--accent2", a);
    root.style.setProperty("--grad", `linear-gradient(135deg, ${a}, ${a})`);
  } else {
    const [c1, c2] = dark ? c.d : c.l;
    root.style.setProperty("--accent", c1);
    root.style.setProperty("--accent2", c2);
    root.style.setProperty("--grad", `linear-gradient(135deg, ${c1}, ${c2})`);
  }
  // 深色主题下强调色是浅色粉彩，其上的勾/图标/文字需改用深色墨保证对比度
  root.dataset.accentInk = c.ink || dark ? "1" : "0";
}

function applyTheme() {
  document.documentElement.dataset.theme = settings.theme;
  const sd = $("#setDark");
  if (sd) sd.checked = settings.theme === "dark";
  applyStyle();
}

// 设置弹窗内的风格分段器 + 色板渲染
function renderStyleSeg() {
  for (const b of $("#styleSeg").children) {
    b.classList.toggle("active", b.dataset.style === settings.style);
  }
}

function renderAccentSwatches() {
  const box = $("#accentSwatches");
  box.innerHTML = "";
  const dark = settings.theme === "dark";
  for (const c of currentPalette()) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch" + (c.id === settings.accent ? " on" : "");
    b.title = c.name;
    b.setAttribute("aria-label", c.name);
    b.style.background =
      settings.style === "things"
        ? dark
          ? c.dark
          : c.light
        : `linear-gradient(135deg, ${dark ? c.d[0] : c.l[0]}, ${dark ? c.d[1] : c.l[1]})`;
    b.addEventListener("click", () => {
      settings.accent = c.id;
      saveSettings();
      applyStyle();
      renderAccentSwatches();
    });
    box.appendChild(b);
  }
}

$("#styleSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-style]");
  if (!b || b.dataset.style === settings.style) return;
  settings.style = b.dataset.style;
  if (!currentPalette().some((x) => x.id === settings.accent)) settings.accent = currentPalette()[0].id;
  saveSettings();
  applyStyle();
  renderStyleSeg();
  renderAccentSwatches();
});

$("#setDark").addEventListener("change", (e) => {
  settings.theme = e.target.checked ? "dark" : "light";
  saveSettings();
  applyTheme();
  renderAccentSwatches();
});

/* ARCHIVE-CODEC-START ---------------- 存档编解码（v3：短键名 + 省略默认值 + gzip） ----------------
 * 云端/备份存档格式：gzip( JSON.stringify({app,v:3,at,tasks:[packTask...]}) )
 * 注：陪伴起点只认云端 profiles.first_at（本地不存，导别人的包不影响自己的起点）
 * 本地存储（LS 快照文件）仍为原始全字段 JSON（loadTasks/saveTasks 不变，零迁移）
 * 导入自动识别：gzip 魔数 → v3 存档；否则 → 旧版明文 JSON（长键名，同样兼容）
 * ============================================================ */
const ARCHIVE_KEYMAP = {
  id: "i", title: "t", start: "s", due: "d", done: "o", note: "n",
  priority: "p", tags: "g", repeat: "r", repeatDays: "w",
  createdAt: "c", completedAt: "f", generatedFrom: "x", generatedNextId: "y",
  updatedAt: "u", ord: "q",
};
const ARCHIVE_KEYMAP_R = Object.fromEntries(
  Object.entries(ARCHIVE_KEYMAP).map(([k, v]) => [v, k])
);

// 打包单条任务：短键名 + 省略 null/默认值（createdAt 参与排序，始终保留）
function packTask(t) {
  const o = { i: t.id, t: t.title, s: t.start, o: t.done, c: t.createdAt, u: t.updatedAt || t.createdAt };
  if (typeof t.ord === "number") o.q = t.ord;
  if (t.due) o.d = t.due;
  if (t.note) o.n = t.note;
  if (t.priority !== "none") o.p = t.priority;
  if (t.tags && t.tags.length) o.g = t.tags;
  if (t.repeat !== "none") {
    o.r = t.repeat;
    if (t.repeatDays && t.repeatDays.length) o.w = t.repeatDays;
  }
  if (t.completedAt) o.f = t.completedAt;
  if (t.generatedFrom) o.x = t.generatedFrom;
  if (t.generatedNextId) o.y = t.generatedNextId;
  return o;
}

// 解包单条任务：还原键名后交给 normalizeTask 补默认值（长键名旧格式也直接透传）
function unpackTask(o) {
  const t = {};
  for (const k in o) t[ARCHIVE_KEYMAP_R[k] || k] = o[k];
  return normalizeTask(t);
}

async function gzipText(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipBytes(buf) {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

// 生成存档 Blob；不支持 CompressionStream 的旧浏览器退化为明文 v3 JSON
async function buildArchiveBlob(taskList) {
  const payload = JSON.stringify({
    app: "todolist", v: 3, at: new Date().toISOString(), tasks: taskList.map(packTask),
  });
  if (typeof CompressionStream !== "undefined") {
    return { blob: new Blob([await gzipText(payload)], { type: "application/gzip" }), gz: true };
  }
  return { blob: new Blob([payload], { type: "application/json" }), gz: false };
}
/* ARCHIVE-CODEC-END */

/* ---------------- 导入 / 导出 ---------------- */
$("#exportBtn").addEventListener("click", async () => {
  const { blob, gz } = await buildArchiveBlob(tasks);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const d = new Date();
  a.href = url;
  a.download = `todo-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.${gz ? "json.gz" : "json"}`;
  a.click();
  URL.revokeObjectURL(url);
  toast(`已导出 ${tasks.length} 条任务备份`);
});

$("#importBtn").addEventListener("click", () => $("#importFile").click());

$("#importFile").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = ""; // 允许重复选择同一文件
  if (!file) return;
  closeSettingsModal(); // 先关设置弹窗，避免遮挡导入确认框
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const buf = new Uint8Array(reader.result);
      let data;
      if (buf[0] === 0x1f && buf[1] === 0x8b) {
        if (typeof DecompressionStream === "undefined") throw new Error("need gzip support");
        data = JSON.parse(await gunzipBytes(buf));
      } else {
        data = JSON.parse(new TextDecoder("utf-8").decode(buf));
      }
      const incomingTasks = Array.isArray(data) ? data : data.tasks;
      if (!Array.isArray(incomingTasks)) throw new Error("invalid");
      const imported = incomingTasks.map(unpackTask);
      openConfirm(
        "导入备份",
        `备份文件包含 ${imported.length} 条任务，导入后将替换当前的全部数据。是否继续？`,
        () => {
          tasks = imported;
          saveTasks();
          render();
          toast(`已导入 ${imported.length} 条任务`);
        },
        "导入"
      );
    } catch {
      toast("导入失败：不是有效的备份文件");
    }
  };
  reader.readAsArrayBuffer(file);
});

/* ---------------- 清空所有数据 ---------------- */
$("#clearAllBtn").addEventListener("click", () => {
  if (!tasks.length) {
    toast("当前没有任何数据");
    return;
  }
  closeSettingsModal(); // 避免遮挡确认框
  openConfirm(
    "清空所有数据",
    `将删除全部 ${tasks.length} 条任务并清空本地存档，此操作不可撤销。是否继续？`,
    () => {
      tasks = [];
      saveTasks();
      render();
      toast("已清空所有数据");
    },
    "清空"
  );
});

/* ---------------- 到期提醒横幅 ----------------
 * 启动、云同步合并、每 30 秒巡检时重新评估：
 * 有过期/今日到期 → 弹出；全部处理完 → 自动收起；
 * 用户手动关闭后本轮不再弹，直到提醒清零重新计。 */
let reminderDismissed = false;
function checkReminders() {
  const dueToday = tasks.filter(isDueToday);
  const overdue = tasks.filter(isOverdue);
  if (dueToday.length === 0 && overdue.length === 0) {
    $("#reminderBanner").classList.add("hidden");
    reminderDismissed = false;
    return;
  }
  if (reminderDismissed) return;
  const parts = [];
  if (overdue.length > 0) parts.push(`<strong>${overdue.length}</strong> 项任务已过期`);
  if (dueToday.length > 0) parts.push(`<strong>${dueToday.length}</strong> 项任务今日到期`);
  $("#reminderText").innerHTML = `提醒：${parts.join("，")}`;
  $("#reminderBanner").classList.remove("hidden");
}

$("#reminderView").addEventListener("click", () => {
  searchQuery = "";
  $("#searchInput").value = "";
  activeTags.clear();
  selectedDate = todayKey();
  setFilter(tasks.some(isOverdue) ? "overdue" : "all");
  reminderDismissed = true;
  $("#reminderBanner").classList.add("hidden");
});

$("#reminderClose").addEventListener("click", () => {
  reminderDismissed = true;
  $("#reminderBanner").classList.add("hidden");
});

/* ---------------- Electron 集成（Web 模式下 ELECTRON 为 null，全部跳过） ---------------- */
const ELECTRON = typeof window !== "undefined" ? window.electronAPI || null : null;

/* ---------------- 华为账号登录（Electron 走主进程 OAuth；Web 端提示用桌面版） ---------------- */
{
  const HW_LABEL = "华为账号登录";
  $("#hwLoginBtn").addEventListener("click", async () => {
    if (!ELECTRON || !ELECTRON.hwLogin) {
      toast("华为账号登录需在桌面版中使用");
      return;
    }
    const btn = $("#hwLoginBtn");
    if (btn.classList.contains("busy")) return;
    btn.classList.add("busy");
    btn.textContent = "等待授权完成…";
    let r;
    try {
      r = await ELECTRON.hwLogin();
    } catch (e) {
      r = { error: (e && e.message) || String(e) };
    }
    btn.classList.remove("busy");
    btn.textContent = HW_LABEL;
    if (!r) return;
    if (r.error) {
      if (r.error !== "canceled") toast("华为登录失败：" + r.error);
      return;
    }
    const key = "hwid:" + r.openID;
    const accounts = loadAccounts();
    if (!accounts[key]) {
      accounts[key] = { name: r.name || "华为用户", provider: "hwid", createdAt: Date.now() };
    } else if (r.name && accounts[key].provider === "hwid") {
      accounts[key].name = r.name; // 跟随华为昵称更新
    }
    delete accounts[key].firstAt; // 陪伴起点不再本地存储，唯一来源为云端 profiles.first_at
    // 用华为凭证换 Supabase 会话（失败不阻断本地登录，重新登录可重试）
    btn.textContent = "连接云端…";
    // 上报本地最早任务创建时间：首次建号时云端 first_at 以它为准
    let firstTaskAt = 0;
    for (const t of tasks) if (t.createdAt && (!firstTaskAt || t.createdAt < firstTaskAt)) firstTaskAt = t.createdAt;
    const ex = await sbExchange(r, firstTaskAt);
    btn.textContent = HW_LABEL; // 无论成败都恢复按钮文案
    if (ex.sb) accounts[key].sb = ex.sb;
    saveAccounts(accounts);
    LS.setItem(SESSION_KEY, key);
    closeAccountModal();
    renderAccountModal();
    if (ex.sb) {
      toast(`华为账号登录成功，欢迎你，${accounts[key].name}`);
      startRealtime();
      setTimeout(autoSync, 800); // 登录后自动拉取合并（本地为空则回填云端数据）
    } else {
      toast(`已登录 ${accounts[key].name}，但云端会话获取失败：${ex.err}`);
    }
  });
}

/* ---------------- 谷歌账号登录（Electron：系统浏览器 + 本机回环回调 + PKCE） ---------------- */
{
  const GG_LABEL = "谷歌账号登录";
  $("#ggLoginBtn").addEventListener("click", async () => {
    if (!ELECTRON || !ELECTRON.googleLogin) {
      toast("谷歌账号登录需在桌面版中使用");
      return;
    }
    const btn = $("#ggLoginBtn");
    if (btn.classList.contains("busy")) return;
    btn.classList.add("busy");
    btn.textContent = "等待授权完成…";
    let r;
    try {
      r = await ELECTRON.googleLogin();
    } catch (e) {
      r = { error: (e && e.message) || String(e) };
    }
    btn.classList.remove("busy");
    btn.textContent = GG_LABEL;
    if (!r) return;
    if (r.error) {
      if (r.error !== "canceled") toast("谷歌登录失败：" + r.error);
      return;
    }
    const key = "ggl:" + r.sub;
    const accounts = loadAccounts();
    if (!accounts[key]) {
      accounts[key] = { name: r.name || "谷歌用户", provider: "google", createdAt: Date.now() };
    } else if (r.name && accounts[key].provider === "google") {
      accounts[key].name = r.name; // 跟随谷歌昵称更新
    }
    delete accounts[key].firstAt; // 陪伴起点唯一来源为云端 profiles.first_at
    btn.textContent = "连接云端…";
    // 上报本地最早任务创建时间：首次建号时云端 first_at 以它为准
    let firstTaskAt = 0;
    for (const t of tasks) if (t.createdAt && (!firstTaskAt || t.createdAt < firstTaskAt)) firstTaskAt = t.createdAt;
    const ex = await sbExchange(r, firstTaskAt, "google");
    btn.textContent = GG_LABEL; // 无论成败都恢复按钮文案
    if (ex.sb) accounts[key].sb = ex.sb;
    saveAccounts(accounts);
    LS.setItem(SESSION_KEY, key);
    closeAccountModal();
    renderAccountModal();
    if (ex.sb) {
      toast(`谷歌账号登录成功，欢迎你，${accounts[key].name}`);
      startRealtime();
      setTimeout(autoSync, 800); // 登录后自动拉取合并（本地为空则回填云端数据）
    } else {
      toast(`已登录 ${accounts[key].name}，但云端会话获取失败：${ex.err}`);
    }
  });
}

/* ---------------- 云端同步（Supabase Storage · 全自动合并） ----------------
 * 与鸿蒙版共用同一 Supabase 项目与 auth 用户。
 * 桌面端存档为 gzip：{sbUserId}/sync.json.gz（v4 信封：updatedAt + 删除墓碑）；
 * 拉取时若 .gz 不存在则回退读鸿蒙明文 {sbUserId}/sync.json，保持跨端可互读。
 * 会话来源：登录时经 Edge Function huawei-auth 换取，存账户记录 acc.sb，过期自动续期。
 * ============================================================ */
const SB_URL = "https://rqrijcjzhipcwdrgrgwf.supabase.co";
const SB_ANON = "sb_publishable_7V8Ov31ZYw2LpP5PgbkswQ_PF3gw5C7";

// 第三方凭证 → Supabase 会话（Edge Function：huawei-auth / google-auth）
// 成功返回 { sb }，失败返回 { err }（带原因，便于区分断网/服务端错误）
async function sbExchange(r, firstTaskAt, provider) {
  const isGoogle = provider === "google";
  try {
    const res = await fetch(`${SB_URL}/functions/v1/${isGoogle ? "google-auth" : "huawei-auth"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SB_ANON },
      // firstTaskAt：本地最早任务创建时间，首次建号时云端 first_at 以它为准
      body: JSON.stringify(
        isGoogle
          ? { idToken: r.idToken || "", firstTaskAt: firstTaskAt || 0 }
          : { idToken: r.idToken || "", huaweiAccessToken: r.accessToken || "", firstTaskAt: firstTaskAt || 0 }
      ),
    });
    if (!res.ok) return { err: "云端返回 HTTP " + res.status };
    const d = await res.json();
    if (!d.access_token || !d.user_id) return { err: "云端未返回有效会话" };
    return {
      sb: {
        access_token: d.access_token,
        refresh_token: d.refresh_token || "",
        expiresAt: Date.now() + (d.expires_in || 3600) * 1000,
        userId: d.user_id,
        // 云端陪伴起点（profiles.first_at），登录时用于回拨对齐
        cloudFirstAt: Number(d.profile && d.profile.first_at) || 0,
        // 华为头像（profiles.avatar_url，由 Edge Function 从凭证解析入库）
        avatar: String((d.profile && d.profile.avatar_url) || ""),
      },
    };
  } catch (e) {
    return { err: "网络不通（" + ((e && e.message) || e) + "），请确认代理已开启" };
  }
}

// 取有效 Supabase 会话；临近过期（<60s）先用 refresh_token 续期
async function ensureSbSession(key) {
  const accounts = loadAccounts();
  const acc = accounts[key];
  if (!acc || !acc.sb || !acc.sb.access_token) return null;
  if (acc.sb.expiresAt - Date.now() > 60000) return acc.sb;
  try {
    const res = await fetch(`${SB_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SB_ANON },
      body: JSON.stringify({ refresh_token: acc.sb.refresh_token }),
    });
    if (!res.ok) return null;
    const d = await res.json();
    acc.sb = {
      access_token: d.access_token,
      refresh_token: d.refresh_token || acc.sb.refresh_token,
      expiresAt: Date.now() + (d.expires_in || 3600) * 1000,
      userId: acc.sb.userId,
      cloudFirstAt: acc.sb.cloudFirstAt || 0,
      avatar: acc.sb.avatar || "",
    };
    saveAccounts(accounts);
    return acc.sb;
  } catch {
    return null;
  }
}

const sbStorageUrl = (sb, name) => `${SB_URL}/storage/v1/object/sync/${sb.userId}/${name}`;
const sbAuthHeaders = (sb) => ({ apikey: SB_ANON, Authorization: `Bearer ${sb.access_token}` });

// 已登录但本地会话缓存里没有云端起点（老版本升级/换设备）：启动时从 profiles 拉一次
async function syncCloudFirstAt() {
  const user = currentUser();
  if (!user || !["hwid", "google"].includes(user.provider)) return;
  const accounts = loadAccounts();
  const acc = accounts[user.key];
  if (!acc || !acc.sb) return;
  if (acc.sb.cloudFirstAt && acc.sb.avatar) return; // 起点和头像都已缓存则不必拉
  const sb = await ensureSbSession(user.key);
  if (!sb) return;
  try {
    const res = await fetch(`${SB_URL}/rest/v1/profiles?select=first_at,avatar_url&uid=eq.${sb.userId}`, {
      headers: sbAuthHeaders(sb),
    });
    if (!res.ok) return;
    const rows = await res.json();
    const p = rows && rows[0];
    const fa = p ? Number(p.first_at) : 0;
    const av = p ? String(p.avatar_url || "") : "";
    if (fa || av) {
      if (fa) acc.sb.cloudFirstAt = fa;
      if (av) acc.sb.avatar = av;
      saveAccounts(accounts);
      renderAccountModal();
    }
  } catch {}
}

// v4 存档只读通道：仅供 v4→v5 首迁取最后一次基线（正常同步已走 op-log，不再写 Storage）
// 返回 null 表示云端尚无存档；抛错表示失败
async function cloudPull() {
  const user = currentUser();
  if (!user) throw new Error("未登录");
  const sb = await ensureSbSession(user.key);
  if (!sb) throw new Error("云端会话已失效，请重新登录华为账号");
  // 优先读桌面端 gzip 存档；不存在则回退读鸿蒙明文存档
  let res = await fetch(sbStorageUrl(sb, "sync.json.gz"), { headers: sbAuthHeaders(sb) });
  if (res.status === 400 || res.status === 404) {
    res = await fetch(sbStorageUrl(sb, "sync.json"), { headers: sbAuthHeaders(sb) });
  }
  if (res.status === 400 || res.status === 404) return null;
  if (!res.ok) throw new Error("下载失败（HTTP " + res.status + "）");
  const buf = new Uint8Array(await res.arrayBuffer());
  let data;
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    if (typeof DecompressionStream === "undefined") throw new Error("需要 gzip 支持");
    data = JSON.parse(await gunzipBytes(buf));
  } else {
    data = JSON.parse(new TextDecoder("utf-8").decode(buf));
  }
  if (!data || !Array.isArray(data.tasks)) throw new Error("云端存档格式不正确");
  return data;
}

// 应用云端 settings：仅当云端更新（modified 更大）时覆盖本地
function applyCloudSettings(s) {
  if (!s || typeof s !== "object") return false;
  const remoteModified = typeof s.modified === "number" ? s.modified : 0;
  if (remoteModified && remoteModified <= (settings.modified || 0)) return false;
  if (s.theme === "light" || s.theme === "dark") settings.theme = s.theme;
  if (["due", "priority", "manual"].includes(s.sortMode)) settings.sortMode = s.sortMode;
  if (typeof s.sound === "boolean") settings.sound = s.sound;
  if (typeof s.notifications === "boolean") settings.notifications = s.notifications;
  if (["things", "soft"].includes(s.style)) settings.style = s.style;
  if (VALID_ACCENTS.has(s.accent)) settings.accent = s.accent;
  settings.modified = remoteModified || Date.now();
  lastSettingsSig = settingsContentSig(); // 远端应用后同步基线，避免本地 saveSettings 误记 op
  saveSettings();
  applyTheme();
  renderStyleSeg();
  renderAccentSwatches();
  $("#sortSelect").value = settings.sortMode;
  $("#setSound").checked = settings.sound;
  $("#setNotify").checked = settings.notifications;
  return true;
}

/* ---------------- 云同步（全自动 · v4 合并） ----------------
 * 本地任何改动 2s 防抖后自动推送 gzip 存档 + sync_state 触发行；
 * Realtime 监听触发行 → 自动拉取并按任务合并（updatedAt LWW + 删除墓碑）；
 * 合并前存本地快照（最多 5 版），toast 可一键撤销。
 * 守卫：本地无任务且无墓碑时绝不推送；退出登录不做任何网络操作。
 * ============================================================ */
let cloudBusy = false;
let cloudPending = false;
let pushTimer = null;
let remoteTimer = null;
let lastPushAt = 0;
let pollSeenAt = 0; // 轮询已见的触发行时间戳（避免重复下载）

function canSync() {
  const user = currentUser();
  if (!user || !["hwid", "google"].includes(user.provider)) return false;
  const acc = loadAccounts()[user.key];
  return !!(acc && acc.sb && acc.sb.userId);
}

function refreshSyncStatus() {
  if (!$("#accountModal").classList.contains("hidden")) renderAccountModal();
}

/* ---- 历史快照：撤销依据，最多 5 版 ---- */
function loadHistory() {
  try {
    const h = JSON.parse(LS.getItem(HISTORY_KEY));
    return Array.isArray(h) ? h : [];
  } catch {
    return [];
  }
}
function pushHistory() {
  const hist = loadHistory();
  hist.push({
    at: Date.now(),
    tasks: JSON.parse(JSON.stringify(tasks)),
    deletions: JSON.parse(JSON.stringify(deletions)),
    settings: JSON.parse(JSON.stringify(settings)),
  });
  while (hist.length > 5) hist.shift();
  LS.setItem(HISTORY_KEY, JSON.stringify(hist));
}

/* ---- 逐任务合并：墓碑压制 + updatedAt LWW；本地保序，远端新任务追加末尾 ----
 * v3 旧存档（鸿蒙未升级前）按 legacy 模式处理：只增不删、不覆盖本地。 */
function mergeRemote(data) {
  const legacy = !(data.v >= 4);
  const remoteDel = legacy ? {} : Object.fromEntries(Array.isArray(data.deletions) ? data.deletions : []);
  for (const id in remoteDel) {
    const ts = remoteDel[id];
    if (typeof ts === "number" && (!(id in deletions) || ts > deletions[id])) deletions[id] = ts;
  }
  const remoteMap = new Map();
  for (const pack of data.tasks) {
    const t = unpackTask(pack);
    if (t && t.id) remoteMap.set(t.id, t);
  }
  const localMap = new Map();
  for (const t of tasks) localMap.set(t.id, t);
  const result = [];
  const seen = new Set();
  let changed = 0;
  // 以远端数组顺序为准：拖拽重排不盖 updatedAt，顺序信息只存在于 gz 的数组位置里
  for (const [id, rem] of remoteMap) {
    seen.add(id);
    const loc = localMap.get(id);
    const ru = rem.updatedAt || 0;
    const tomb = deletions[id] || 0;
    if (loc) {
      const lu = loc.updatedAt || 0;
      if (tomb && tomb >= Math.max(lu, ru)) { changed++; continue; } // 被删除（任一端）
      if (ru > lu) { result.push(rem); changed++; continue; }        // 远端更新
      result.push(loc);
    } else {
      if (!legacy && tomb && tomb >= ru) { changed++; continue; }
      result.push(rem);
      changed++;
    }
  }
  // 仅本地有的任务（另一端还没有）追加到末尾
  for (const t of tasks) {
    if (seen.has(t.id)) continue;
    const tomb = deletions[t.id] || 0;
    if (tomb && tomb >= (t.updatedAt || 0)) { changed++; continue; }
    result.push(t);
  }
  // 纯重排不产生 updatedAt 差异：用顺序对比识别"只有顺序变了"的情况
  if (!changed) {
    if (result.length !== tasks.length) changed = 1;
    else for (let i = 0; i < result.length; i++) if (result[i].id !== tasks[i].id) { changed = 1; break; }
  }
  // 最终顺序以 ord 序号裁决（逐任务 LWW 已选出最新的 ord；无 ord 的旧数据稳定排在末尾）
  result.sort((a, b) => {
    const A = typeof a.ord === "number" ? a.ord : Infinity;
    const B = typeof b.ord === "number" ? b.ord : Infinity;
    return A - B;
  });
  return { legacy, result, changed, count: result.length };
}

function popHistory() {
  const hist = loadHistory();
  hist.pop();
  LS.setItem(HISTORY_KEY, JSON.stringify(hist));
}

function applyMerged(merged) {
  applyingRemote = true;
  tasks = merged.result;
  saveTasks();
  saveDeletions();
  applyingRemote = false;
  render();
  checkReminders();
}

/* ============================================================
 * v5 同步层：操作流水（op-log）
 * 本地每个改动记一条 op（add/update/delete/settings）→ outbox →
 * 批量插入 tasks_op 表（op_id 幂等）；拉取按服务端 seq 游标增量回放。
 * 回放规则：update/delete 落在不存在的任务 → 跳过（删除赢）；
 *           add 落在不存在的任务 → 插入（复活/重导入唯一入口）。
 * 同步模式已定稿为纯 op-log（原灰度开关 todolist.sync.v 已移除）。
 * ============================================================ */
/* 存储键常量已提前到数据层声明（见文件顶部，避免 TDZ） */

function deviceId() {
  let d = LS.getItem(DEVICE_ID_KEY);
  if (!d) {
    d = uid();
    LS.setItem(DEVICE_ID_KEY, d);
  }
  return d;
}

// 参与同步的设置子集（v4 信封与 v5 settings op 共用）
function settingsSubset() {
  return {
    theme: settings.theme,
    sortMode: settings.sortMode,
    sound: settings.sound,
    notifications: settings.notifications,
    style: settings.style,
    accent: settings.accent,
    modified: settings.modified || 0,
  };
}
function settingsContentSig() {
  const s = settingsSubset();
  delete s.modified; // modified 每次必变，不参与内容比较
  return JSON.stringify(s);
}
let lastSettingsSig = settingsContentSig();

let opOutbox = (() => {
  try {
    const a = JSON.parse(LS.getItem(OP_OUTBOX_KEY));
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
})();
let opApplied = (() => {
  try {
    const a = JSON.parse(LS.getItem(OP_APPLIED_KEY));
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
})();
let opAppliedSet = new Set(opApplied);
let opTaskMeta = (() => {
  try {
    return JSON.parse(LS.getItem(OP_META_KEY)) || {};
  } catch {
    return {};
  }
})();
let opCursor = Number(LS.getItem(OP_CURSOR_KEY)) || 0;
let ckptState = (() => {
  try {
    return JSON.parse(LS.getItem(OP_CKPT_KEY)) || { at: 0, applied: 0 };
  } catch {
    return { at: 0, applied: 0 };
  }
})();

function saveOutbox() {
  LS.setItem(OP_OUTBOX_KEY, JSON.stringify(opOutbox));
}
function saveAppliedRing() {
  LS.setItem(OP_APPLIED_KEY, JSON.stringify(opApplied));
}
function saveTaskMeta() {
  LS.setItem(OP_META_KEY, JSON.stringify(opTaskMeta));
}
function saveCursor() {
  LS.setItem(OP_CURSOR_KEY, String(opCursor));
}

function markApplied(opId) {
  if (opAppliedSet.has(opId)) return;
  opAppliedSet.add(opId);
  opApplied.push(opId);
  while (opApplied.length > 500) opAppliedSet.delete(opApplied.shift());
  saveAppliedRing();
}

// op-log 生效：云会话已建立、本账号已完成首迁
function oplogActive() {
  const user = currentUser();
  if (!user || !["hwid", "google"].includes(user.provider)) return false;
  const acc = loadAccounts()[user.key];
  return !!(acc && acc.sb && acc.sb.userId && acc.v5Migrated);
}

function enqueueOp(op) {
  const rec = {
    op_id: uid(),
    type: op.type,
    task_id: op.task_id || null,
    payload: op.payload || {},
    client_ts: op.client_ts || Date.now(),
    device_id: deviceId(),
  };
  opOutbox.push(rec);
  markApplied(rec.op_id); // 本地状态已反映该操作，回放拉回时跳过
  saveOutbox();
}

// saveTasks 的 diff 结果 → op（update 只带变更字段，null 表示删除该字段）
function emitTaskOps(added, changed, removed, now) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const id of added) {
    const t = byId.get(id);
    if (t) enqueueOp({ type: "add", task_id: id, payload: packTask(t), client_ts: t.updatedAt || now });
  }
  for (const c of changed) {
    const t = byId.get(c.id);
    if (!t) continue;
    const newPack = packTask(t);
    const diff = {};
    let has = false;
    for (const k in newPack) {
      if (JSON.stringify(newPack[k]) !== JSON.stringify(c.oldPack[k])) {
        diff[k] = newPack[k];
        has = true;
      }
    }
    for (const k in c.oldPack) {
      if (!(k in newPack)) {
        diff[k] = null;
        has = true;
      }
    }
    diff.u = t.updatedAt || now; // updatedAt 随操作走，回放端据此保持时间语义
    if (has) enqueueOp({ type: "update", task_id: c.id, payload: diff, client_ts: t.updatedAt || now });
  }
  for (const id of removed) enqueueOp({ type: "delete", task_id: id, payload: {}, client_ts: now });
}

// 退出登录时清空 op-log 本地状态（游标/去重环跟着账号走，不能串号）
function resetOplogLocal() {
  opOutbox = [];
  opApplied = [];
  opAppliedSet = new Set();
  opTaskMeta = {};
  opCursor = 0;
  ckptState = { at: 0, applied: 0 };
  LS.removeItem(OP_OUTBOX_KEY);
  LS.removeItem(OP_APPLIED_KEY);
  LS.removeItem(OP_META_KEY);
  LS.removeItem(OP_CURSOR_KEY);
  LS.removeItem(OP_CKPT_KEY);
}

/* ---- 推送：outbox 批量插入 tasks_op（幂等），成功后写 sync_state 门铃 ---- */
async function pushOps() {
  if (!opOutbox.length) return;
  const user = currentUser();
  if (!user) return;
  const sb = await ensureSbSession(user.key);
  if (!sb) throw new Error("云端会话已失效");
  while (opOutbox.length) {
    const batch = opOutbox.slice(0, 100).map((o) => ({
      uid: sb.userId,
      op_id: o.op_id,
      type: o.type,
      task_id: o.task_id,
      payload: o.payload,
      client_ts: o.client_ts,
      device_id: o.device_id,
    }));
    const res = await fetch(`${SB_URL}/rest/v1/tasks_op`, {
      method: "POST",
      headers: { ...sbAuthHeaders(sb), "Content-Type": "application/json", Prefer: "resolution=ignore-duplicates" },
      body: JSON.stringify(batch),
    });
    if (!res.ok) throw new Error("操作推送失败（HTTP " + res.status + "）");
    opOutbox.splice(0, batch.length);
    saveOutbox();
  }
  // 门铃：其他设备 Realtime/轮询感知后拉取（机制与 v4 完全一致）
  try {
    await fetch(`${SB_URL}/rest/v1/sync_state?on_conflict=uid`, {
      method: "POST",
      headers: { ...sbAuthHeaders(sb), "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ uid: sb.userId, at: Date.now() }),
    });
  } catch {}
  try {
    await fetch(`${SB_URL}/rest/v1/sync_cursor?on_conflict=uid,device_id`, {
      method: "POST",
      headers: { ...sbAuthHeaders(sb), "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ uid: sb.userId, device_id: deviceId(), last_seq: opCursor, updated_at: new Date().toISOString() }),
    });
  } catch {}
  const accounts = loadAccounts();
  if (accounts[user.key]) {
    accounts[user.key].lastSyncMs = Date.now();
    saveAccounts(accounts);
  }
}

/* ---- 回放：按 seq 升序应用一批 op（期间 applyingRemote 抑制 op 再产出） ---- */
function applyTaskOp(op, lookback) {
  const i = tasks.findIndex((t) => t.id === op.task_id);
  if (op.type === "update" && i < 0) return false; // 删除赢：改不存在的任务直接跳过
  // 回看补偿路径可能乱序到达：用 client_ts+device_id 做 LWW 守卫，旧操作不覆盖新操作
  if (lookback && i >= 0) {
    const m = opTaskMeta[op.task_id];
    if (m && (op.client_ts < m[0] || (op.client_ts === m[0] && String(op.device_id || "") <= String(m[1] || "")))) return false;
  }
  let pack;
  if (i >= 0) {
    pack = packTask(tasks[i]);
    for (const k in op.payload) {
      if (op.payload[k] === null) delete pack[k];
      else pack[k] = op.payload[k];
    }
  } else {
    if (op.type !== "add") return false;
    pack = { ...op.payload }; // add 的 payload 是整条 packTask
  }
  const t = unpackTask(pack);
  if (!t || !t.id) return false;
  if (i >= 0) tasks[i] = t;
  else tasks.push(t);
  opTaskMeta[t.id] = [Number(op.client_ts) || 0, String(op.device_id || "")];
  return true;
}

function replayOps(ops, lookback) {
  if (!ops.length) return 0;
  pushHistory(); // 远端批次应用前先存快照（撤销依据）
  applyingRemote = true;
  let applied = 0;
  let changed = false;
  try {
    for (const op of ops) {
      if (!op || !op.op_id || opAppliedSet.has(op.op_id)) continue;
      const payload = op.payload || {};
      if (op.type === "settings") {
        if (applyCloudSettings(payload)) changed = true;
      } else if (op.type === "add" || op.type === "update") {
        if (applyTaskOp(op, lookback)) changed = true;
      } else if (op.type === "delete") {
        const i = tasks.findIndex((t) => t.id === op.task_id);
        if (i >= 0) {
          tasks.splice(i, 1);
          delete opTaskMeta[op.task_id];
          changed = true;
        }
      }
      markApplied(op.op_id);
      applied++;
    }
    if (changed) {
      saveTasks(); // applyingRemote=true：只落盘 + 刷新签名，不产出 op
      saveTaskMeta();
      render();
      checkReminders();
    } else {
      popHistory();
    }
  } finally {
    applyingRemote = false;
  }
  return applied;
}

/* ---- 掉队重建：本地游标小于云端最小 seq（流水被修剪）→ 用检查点快照整包替换 ---- */
async function rebuildFromCheckpoint(sb) {
  const res = await fetch(`${SB_URL}/rest/v1/sync_checkpoint?uid=eq.${sb.userId}&select=seq,snapshot`, {
    headers: sbAuthHeaders(sb),
  });
  if (!res.ok) throw new Error("检查点读取失败（HTTP " + res.status + "）");
  const rows = await res.json();
  if (!rows.length) {
    opCursor = 0; // 无检查点（理论上修剪不会发生）：游标归零重新拉
    saveCursor();
    return;
  }
  const ck = rows[0];
  const snap = ck.snapshot || {};
  pushHistory();
  applyingRemote = true;
  try {
    if (Array.isArray(snap.tasks)) tasks = snap.tasks.map(unpackTask).filter(Boolean);
    saveTasks();
    if (snap.settings) applyCloudSettings(snap.settings);
    render();
    checkReminders();
  } finally {
    applyingRemote = false;
  }
  opCursor = Number(ck.seq) || 0;
  saveCursor();
  toast("云端流水已归档，已从快照恢复基线");
}

/* ---- 检查点：每应用 >500 条或超 14 天，把本地全量 upsert 到 sync_checkpoint ---- */
async function maybeCheckpoint(sb, appliedCount) {
  ckptState.applied += appliedCount;
  const stale = ckptState.at > 0 ? Date.now() - ckptState.at > 14 * 86400000 : appliedCount > 0;
  if (ckptState.applied < 500 && !stale) {
    LS.setItem(OP_CKPT_KEY, JSON.stringify(ckptState));
    return;
  }
  try {
    const res = await fetch(`${SB_URL}/rest/v1/sync_checkpoint?on_conflict=uid`, {
      method: "POST",
      headers: { ...sbAuthHeaders(sb), "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ uid: sb.userId, seq: opCursor, snapshot: { tasks: tasks.map(packTask), settings: settingsSubset() } }),
    });
    if (res.ok) ckptState = { at: Date.now(), applied: 0 };
  } catch {}
  LS.setItem(OP_CKPT_KEY, JSON.stringify(ckptState));
}

/* ---- 拉取：游标增量 + 回看补偿（seq 空洞自愈）+ 掉队重建 ---- */
async function pullOps(lookback) {
  const user = currentUser();
  if (!user) return 0;
  const sb = await ensureSbSession(user.key);
  if (!sb) throw new Error("云端会话已失效");
  let from = lookback ? Math.max(0, opCursor - 200) : opCursor;
  if (!lookback && opCursor > 0) {
    // 掉队检测：云端最小 seq 已越过本地游标 → 流水被修剪过
    try {
      const r0 = await fetch(`${SB_URL}/rest/v1/tasks_op?select=seq&uid=eq.${sb.userId}&order=seq.asc&limit=1`, {
        headers: sbAuthHeaders(sb),
      });
      if (r0.ok) {
        const rows0 = await r0.json();
        if (rows0.length && Number(rows0[0].seq) > opCursor + 1) {
          await rebuildFromCheckpoint(sb);
          from = opCursor;
        }
      }
    } catch {}
  }
  let total = 0;
  for (;;) {
    const res = await fetch(
      `${SB_URL}/rest/v1/tasks_op?uid=eq.${sb.userId}&seq=gt.${from}&order=seq.asc&limit=500`,
      { headers: sbAuthHeaders(sb) }
    );
    if (!res.ok) throw new Error("操作拉取失败（HTTP " + res.status + "）");
    const ops = await res.json();
    if (!Array.isArray(ops) || !ops.length) break;
    total += replayOps(ops, lookback);
    from = Number(ops[ops.length - 1].seq);
    if (!lookback) {
      opCursor = from;
      saveCursor();
    }
    if (ops.length < 500) break;
  }
  if (total > 0) {
    await maybeCheckpoint(sb, total);
    const accounts = loadAccounts();
    if (accounts[user.key]) {
      accounts[user.key].lastSyncMs = Date.now();
      saveAccounts(accounts);
    }
  }
  return total;
}

/* ---- 首迁（v4→v5，每账号一次）：备份 → 最后一次 v4 合并 → 基线转 add 流水 ---- */
async function migrateV4ToV5() {
  const user = currentUser();
  if (!user) return false;
  const accounts = loadAccounts();
  const acc = accounts[user.key];
  if (!acc || !acc.sb || acc.v5Migrated) return true;
  const sb = await ensureSbSession(user.key);
  if (!sb) return false;
  // 1) 迁移前本地备份（一次性，防回滚）+ 历史快照
  try {
    LS.setItem(
      "todolist.preV5Backup.v1",
      JSON.stringify({ at: Date.now(), tasks: JSON.parse(JSON.stringify(tasks)), deletions: { ...deletions }, settings: { ...settings } })
    );
  } catch {}
  pushHistory();
  // 2) 最后一次 v4 拉取合并，得到基线任务集
  try {
    const data = await cloudPull();
    if (data) {
      applyingRemote = true;
      applyCloudSettings(data.settings);
      applyingRemote = false;
      const merged = mergeRemote(data);
      if (merged.changed > 0) applyMerged(merged);
    }
  } catch {}
  // 3) 基线每条任务一条 add（client_ts=任务自身 updatedAt）+ 一条 settings；墓碑不迁移
  const now = Date.now();
  for (const t of tasks) {
    const tomb = deletions[t.id] || 0;
    if (tomb && tomb >= (t.updatedAt || 0)) continue;
    enqueueOp({ type: "add", task_id: t.id, payload: packTask(t), client_ts: t.updatedAt || t.createdAt || now });
  }
  enqueueOp({ type: "settings", task_id: null, payload: settingsSubset(), client_ts: settings.modified || now });
  // 4) 推送；失败则 outbox 保留，下次 autoSync 重试（v5Migrated 不置位）
  try {
    await pushOps();
  } catch {
    return false;
  }
  acc.v5Migrated = true;
  saveAccounts(accounts);
  return true;
}

/* ---- 自动推送：2s 防抖，空数据 + 无墓碑时绝不推送 ---- */
function scheduleCloudPush() {
  if (!canSync() || applyingRemote) return;
  cloudPending = true;
  refreshSyncStatus();
  clearTimeout(pushTimer);
  pushTimer = setTimeout(doAutoPush, 2000);
}

async function doAutoPush() {
  clearTimeout(pushTimer);
  if (!cloudPending) return;
  // 纯流水：outbox 为空时无事可做
  if (opOutbox.length === 0) {
    cloudPending = false;
    return;
  }
  if (cloudBusy) return;
  cloudPending = false;
  cloudBusy = true;
  refreshSyncStatus(); // 与手机版一致：推送开始即显示"同步中…"
  try {
    if (oplogActive()) await pushOps(); // 操作流水推送
    lastPushAt = Date.now();
    pollSeenAt = Math.max(pollSeenAt, lastPushAt); // 自己写的触发行不必再拉
  } catch {
    cloudPending = true;
    setTimeout(doAutoPush, 15000); // 失败 15s 后重试
  } finally {
    cloudBusy = false;
    refreshSyncStatus();
  }
}

/* ---- 自动拉取 + 合并（manual=手动点击触发，完成后统一提示"同步完成"） ---- */
async function autoSync(manual) {
  if (!canSync() || cloudBusy) return;
  // 首迁（每账号一次）：未迁移时先转基线流水，失败则下轮重试
  {
    const acc = loadAccounts()[currentUser().key];
    if (acc && acc.sb && !acc.v5Migrated) {
      cloudBusy = true;
      refreshSyncStatus();
      let mok = false;
      try {
        mok = await migrateV4ToV5();
      } catch {}
      cloudBusy = false;
      refreshSyncStatus();
      if (!mok) {
        if (manual) toast("同步初始化失败，请稍后重试");
        return;
      }
    }
  }
  if (cloudPending) await doAutoPush();
  if (!canSync() || !oplogActive()) return;
  cloudBusy = true;
  refreshSyncStatus();
  let ok = false;
  try {
    // 纯流水读路径：推待发改动 → 按游标增量拉取回放
    try {
      await pushOps();
      lastPushAt = Date.now(); // 自己写的门铃不必再触发拉取
    } catch {}
    await pullOps(false);
    pollSeenAt = Math.max(pollSeenAt, Date.now());
    ok = true;
  } catch {
    if (manual) toast("同步失败，请检查网络");
  } finally {
    cloudBusy = false;
    refreshSyncStatus();
    if (manual && ok) toast("同步完成");
  }
}

function scheduleRemoteSync() {
  if (Date.now() - lastPushAt < 5000) return; // 忽略自己推送引发的回声
  clearTimeout(remoteTimer);
  remoteTimer = setTimeout(autoSync, 1200);
}

/* ---- 10s 轮询兜底：只查 sync_state 触发行（几十字节），云端有更新才下载合并；
 * Realtime 断线/丢事件时靠它保证最终一致，自身推送/已拉过的存档不会触发重复下载 ---- */
setInterval(async () => {
  if (!canSync() || cloudBusy || cloudPending) return;
  if (Date.now() - lastPushAt < 6000) return;
  try {
    const user = currentUser();
    const sb = await ensureSbSession(user.key);
    if (!sb) return;
    const res = await fetch(`${SB_URL}/rest/v1/sync_state?uid=eq.${sb.userId}&select=at`, {
      headers: sbAuthHeaders(sb),
    });
    if (!res.ok) return;
    const rows = await res.json();
    const at = Array.isArray(rows) && rows.length ? Number(rows[0].at) : 0;
    if (!at) return;
    if (!pollSeenAt) { pollSeenAt = at; return; } // 首次仅记基线（启动时已拉过一遍）
    if (at > pollSeenAt) { pollSeenAt = at; autoSync(); }
  } catch {}
}, 10000);

/* ---- Realtime：订阅 sync_state 触发行（Phoenix WS 协议） ---- */
const rt = { ws: null, hb: null, swap: null, retryTimer: null, ref: 0, retry: 0 };

async function startRealtime() {
  if (!canSync() || (rt.ws && rt.ws.readyState <= 1)) return;
  const user = currentUser();
  const sb = await ensureSbSession(user.key);
  if (!sb || (rt.ws && rt.ws.readyState <= 1)) return;
  rt.retry = 0; // 显式发起（启动/登录/联网）重新计次
  const url = SB_URL.replace(/^http/, "ws") + "/realtime/v1/websocket?apikey=" + SB_ANON + "&vsn=1.0.0";
  let ws;
  try {
    ws = new WebSocket(url);
  } catch {
    scheduleRtRetry();
    return;
  }
  rt.ws = ws;
  ws.onopen = () => {
    rt.retry = 0;
    rt.ref++;
    // 重连即回看补偿一次：自愈 seq 空洞（并发提交可见性延迟）
    setTimeout(() => {
      if (oplogActive() && !cloudBusy) pullOps(true).catch(() => {});
    }, 1500);
    ws.send(
      JSON.stringify({
        topic: "phoenix",
        event: "phx_join",
        ref: String(rt.ref),
        payload: {
          access_token: sb.access_token,
          config: {
            postgres_changes: [
              { event: "*", schema: "public", table: "sync_state", filter: "uid=eq." + sb.userId },
            ],
          },
        },
      })
    );
  };
  ws.onmessage = (e) => {
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    if (typeof m.topic === "string" && m.topic.indexOf("realtime:") === 0) scheduleRemoteSync();
  };
  ws.onclose = () => {
    if (rt.ws === ws) rt.ws = null;
    clearInterval(rt.hb);
    rt.hb = null;
    scheduleRtRetry();
  };
  rt.hb = setInterval(() => {
    if (rt.ws && rt.ws.readyState === 1) {
      rt.ref++;
      rt.ws.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: String(rt.ref) }));
    }
  }, 25000);
  // 每 45 分钟换会话重连一次（token 续期）
  if (!rt.swap) rt.swap = setInterval(() => { stopRealtimeSoft(); startRealtime(); }, 45 * 60000);
}

function scheduleRtRetry() {
  clearTimeout(rt.retryTimer);
  if (rt.retry >= 6) return; // 放弃重连，等登录/联网事件再拉起
  const delay = Math.min(30000, 1000 * 2 ** rt.retry);
  rt.retry++;
  rt.retryTimer = setTimeout(startRealtime, delay);
}

function stopRealtimeSoft() {
  clearTimeout(rt.retryTimer);
  clearInterval(rt.hb);
  rt.hb = null;
  if (rt.ws) {
    try {
      rt.ws.onclose = null;
      rt.ws.close();
    } catch {}
    rt.ws = null;
  }
}

function stopRealtime() {
  clearInterval(rt.swap);
  rt.swap = null;
  stopRealtimeSoft();
}

/* ---- 接线 ---- */
onTasksSaved = scheduleCloudPush;
getSyncStatus = () => ({
  pending: cloudPending,
  busy: cloudBusy,
  connected: !!(rt.ws && rt.ws.readyState === 1),
});

/* ---- v5 回看补偿：空闲 60s 定期重拉游标前 200 条，去重环过滤已应用 ---- */
setInterval(() => {
  if (!oplogActive() || cloudBusy || cloudPending) return;
  pullOps(true).catch(() => {});
}, 60000);

if (canSync()) {
  startRealtime();
  syncCloudFirstAt();
  setTimeout(autoSync, 2500);
}
window.addEventListener("online", () => {
  if (canSync()) {
    startRealtime();
    autoSync();
  }
});

// 点击「云端同步」行：立即强制拉取合并一次（有待推送改动先推再拉）
$("#cloudSyncRow").addEventListener("click", () => {
  if (canSync() && !cloudBusy) autoSync(true);
});

// 到点桌面通知调度：due 落在最近 10 分钟内且未提醒过的未完成任务 → 弹系统通知
// （窗口隐藏进托盘后定时器会被节流，10 分钟回溯窗口可保证不漏提醒）
const notifiedIds = new Set();
function tickNotifications() {
  if (!ELECTRON || settings.notifications === false) return;
  const now = Date.now();
  for (const t of tasks) {
    if (t.done || !t.due || notifiedIds.has(t.id)) continue;
    const dueTs = new Date(t.due).getTime();
    if (dueTs <= now && now - dueTs <= 10 * 60000) {
      notifiedIds.add(t.id);
      ELECTRON.notify("待办提醒", `「${t.title}」已到截止时间（${formatDue(t.due)}）`);
    }
  }
}

if (ELECTRON) {
  // 关闭行为以主进程配置为准（跨重启生效），首次运行用本地设置同步过去
  ELECTRON.cfgGet().then((cfg) => {
    if (cfg && cfg.closeBehavior) {
      settings.closeBehavior = cfg.closeBehavior;
      saveSettings();
    } else {
      ELECTRON.cfgSet("closeBehavior", settings.closeBehavior || "tray");
    }
  });
  // 托盘菜单「新建任务」→ 直接打开任务弹窗
  ELECTRON.onTrayNewTask(() => openTaskModal());
}

/* ---------------- 初始化 ---------------- */
applyTheme();
$("#sortSelect").value = settings.sortMode;
render();
checkReminders();
// 页面保持打开时，定期刷新过期高亮状态 + 检查到点通知
setInterval(() => {
  render();
  tickNotifications();
}, 30000);
if (ELECTRON) tickNotifications();
