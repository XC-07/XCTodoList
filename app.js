"use strict";

/* ============================================================
 * 待办清单 - Web 内核
 * M1：添加 / 编辑 / 删除 / 完成 / 筛选 / 排序 / 本地持久化
 * M2：备注 / 批量清理 / 拖拽排序 / 到期提醒 / 标签 / 优先级
 *     主题切换 / 搜索 / 导入导出 / 重复任务（每日 / 每周指定星期）
 * 按天日程：任务可设开始日期，每天一栏，左右切换 + 小日历选择
 * ============================================================ */

/* ---------------- 数据层 ---------------- */
const STORAGE_KEY = "todo.tasks.v1";
const SETTINGS_KEY = "todo.settings.v1";

let tasks = loadTasks();
let settings = Object.assign(
  { theme: "light", sortMode: "due", sound: true, notifications: true, closeBehavior: "tray" },
  loadSettings()
);
let currentFilter = "all";
let activeTag = null;        // 当前标签筛选
let searchQuery = "";        // 搜索关键词（小写）
let editingId = null;        // 当前编辑的任务 id（null 表示新建）
let confirmCallback = null;  // 确认弹窗回调
let dragId = null;           // 正在拖拽的任务 id
let dropPos = null;          // 拖拽落点 { id, before }
let selectedDate = todayKey(); // 当前查看的日期（YYYY-MM-DD）
let calMonth = new Date();     // 小日历显示的月份

function loadTasks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr)
      ? arr.filter((t) => t && typeof t === "object").map(normalizeTask)
      : [];
  } catch {
    return [];
  }
}

function saveTasks() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
}

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch {
    return {};
  }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

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
    createdAt: t.createdAt || Date.now(),
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
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
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
  if (!s && !e) return true; // 未安排日期的任务：每天都显示（列表末尾单独分组）
  if (s && !e) return t.done ? D === s : D >= s; // 只有开始日期：从开始日起持续显示，完成后只留在开始日
  // 有截止时间（可能还有开始日期）
  const inWindow = s ? D >= s && D <= e : D === e;
  // 未完成且已过期的任务，额外显示在"今天"这一栏，避免被漏掉
  const overdueOnToday = !t.done && D === todayKey() && e < D;
  return inWindow || overdueOnToday;
}

function matchTask(t) {
  // 搜索时跨所有日期查找，否则限定在当前日期栏
  if (!searchQuery && !inSelectedDay(t)) return false;
  switch (currentFilter) {
    case "active": if (t.done) return false; break;
    case "completed": if (!t.done) return false; break;
    case "overdue": if (!isOverdue(t)) return false; break;
  }
  if (activeTag && !t.tags.includes(activeTag)) return false;
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
const FLAG_SVG =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" stroke="none"><path d="M5 3a1 1 0 0 1 1 1v1.1c1.9-.6 3.6-1.4 5.5-1.4 2.5 0 4 1.3 6.5 1.3 1 0 1.8-.2 2.5-.5a.8.8 0 0 1 1 .8v8.2c0 .4-.2.7-.6.9-.9.4-1.9.6-2.9.6-2.5 0-4-1.3-6.5-1.3-1.9 0-3.6.7-5.5 1.4V21a1 1 0 1 1-2 0V4a1 1 0 0 1 1-1Z"/></svg>';
const REPEAT_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>';

const SUN_SVG =
  '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/></svg>';
const MOON_SVG =
  '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>';

function render() {
  $("#dateLabelText").textContent = dayLabel(selectedDate);
  renderList();
  renderCounts();
  renderTagChips();
  renderClearDoneBtn();
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
  if (tasks.length === 0) return "还没有任务，点击「新建任务」开始吧";
  if (activeTag) return `标签「${activeTag}」下暂无任务`;
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
  const tags = [...new Set(tasks.flatMap((t) => t.tags))].sort();
  if (activeTag && !tags.includes(activeTag)) activeTag = null; // 标签已不存在
  if (tags.length === 0) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  box.classList.remove("hidden");
  box.innerHTML = "";
  const label = document.createElement("span");
  label.className = "chip-label";
  label.textContent = "按标签筛选：";
  box.appendChild(label);
  for (const tag of tags) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "tag-chip" + (activeTag === tag ? " active" : "");
    chip.textContent = `# ${tag}`;
    chip.addEventListener("click", () => {
      activeTag = activeTag === tag ? null : tag;
      render();
    });
    box.appendChild(chip);
  }
}

function renderClearDoneBtn() {
  const n = tasks.filter((t) => t.done && inSelectedDay(t)).length;
  const btn = $("#clearDoneBtn");
  btn.classList.toggle("hidden", n === 0);
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
    "task-item" + (t.done ? " done" : "") + (isOverdue(t) ? " overdue" : "");
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

  // 标题行（含优先级旗帜）
  const titleRow = document.createElement("div");
  titleRow.className = "task-title-row";
  if (t.priority !== "none") {
    const flag = document.createElement("span");
    flag.className = `priority-flag p-${t.priority}`;
    flag.innerHTML = FLAG_SVG;
    flag.title = `优先级：${PRIORITY_LABEL[t.priority]}`;
    titleRow.appendChild(flag);
  }
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
  saveTasks();
  render();
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

  if (done && t.repeat !== "none" && t.due) {
    // 幂等生成：本期完成生成的"下一期"已存在时不再重复生成，
    // 防止反复勾选/取消堆积出多个相同副本
    if (!t.generatedNextId || !tasks.find((x) => x.id === t.generatedNextId)) {
      const nextDueStr = nextDue(t.due, t.repeat, t.repeatDays);
      const next = normalizeTask({
        ...t,
        id: uid(),
        due: nextDueStr,
        // 新一期出现在它自己的截止日期那一栏
        start: t.start ? dateKeyOf(nextDueStr) : null,
        done: false,
        createdAt: Date.now(),
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
    cell.addEventListener("click", () => {
      if (dpTarget) dpTarget.value = key;
      closeDatePicker();
    });
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
  if (ELECTRON) {
    $("#electronOnlyFields").classList.remove("hidden");
    ELECTRON.getVersion().then((v) => {
      $("#versionInfo").textContent =
        `待办清单 v${v.app} · Electron ${v.electron} · Chromium ${v.chrome} · Node ${v.node}`;
    });
  } else {
    $("#electronOnlyFields").classList.add("hidden");
    $("#versionInfo").textContent = "待办清单 v1.0.0（Web 版 · 浏览器模式，托盘与桌面通知不可用）";
  }
  $("#settingsModal").classList.remove("hidden");
}

function closeSettingsModal() {
  $("#settingsModal").classList.add("hidden");
}

$("#settingsBtn").addEventListener("click", openSettingsModal);
$("#closeSettingsBtn").addEventListener("click", closeSettingsModal);

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

/* ---------------- 主题切换 ---------------- */
function applyTheme() {
  document.documentElement.dataset.theme = settings.theme;
  $("#themeBtn").innerHTML = settings.theme === "dark" ? SUN_SVG : MOON_SVG;
}

$("#themeBtn").addEventListener("click", () => {
  settings.theme = settings.theme === "dark" ? "light" : "dark";
  saveSettings();
  applyTheme();
});

/* ---------------- 导入 / 导出 ---------------- */
$("#exportBtn").addEventListener("click", () => {
  const data = {
    app: "todolist",
    version: 2,
    exportedAt: new Date().toISOString(),
    tasks,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const d = new Date();
  a.href = url;
  a.download = `todo-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast(`已导出 ${tasks.length} 条任务备份`);
});

$("#importBtn").addEventListener("click", () => $("#importFile").click());

$("#importFile").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = ""; // 允许重复选择同一文件
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const incomingTasks = Array.isArray(data) ? data : data.tasks;
      if (!Array.isArray(incomingTasks)) throw new Error("invalid");
      const imported = incomingTasks.map(normalizeTask);
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
  reader.readAsText(file);
});

/* ---------------- 打开时到期提醒 ---------------- */
function checkReminders() {
  const dueToday = tasks.filter(isDueToday);
  const overdue = tasks.filter(isOverdue);
  if (dueToday.length === 0 && overdue.length === 0) return;
  const parts = [];
  if (overdue.length > 0) parts.push(`<strong>${overdue.length}</strong> 项任务已过期`);
  if (dueToday.length > 0) parts.push(`<strong>${dueToday.length}</strong> 项任务今日到期`);
  $("#reminderText").innerHTML = `提醒：${parts.join("，")}`;
  $("#reminderBanner").classList.remove("hidden");
}

$("#reminderView").addEventListener("click", () => {
  searchQuery = "";
  $("#searchInput").value = "";
  activeTag = null;
  selectedDate = todayKey();
  setFilter(tasks.some(isOverdue) ? "overdue" : "all");
  $("#reminderBanner").classList.add("hidden");
});

$("#reminderClose").addEventListener("click", () =>
  $("#reminderBanner").classList.add("hidden")
);

/* ---------------- Electron 集成（Web 模式下 ELECTRON 为 null，全部跳过） ---------------- */
const ELECTRON = typeof window !== "undefined" ? window.electronAPI || null : null;

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
