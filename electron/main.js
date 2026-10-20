"use strict";

/* ============================================================
 * 待办清单 - Electron 壳（M4）
 * 小竖窗(420×700) / 托盘驻留 / 托盘右键菜单 / 到点桌面通知 / 配置持久化
 * 渲染层通过 preload.js 暴露的 window.electronAPI 与之通信
 * ============================================================ */

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  Notification,
  nativeImage,
} = require("electron");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const CONFIG_FILE = path.join(app.getPath("userData"), "config.json");

/* ---------------- 配置持久化（主进程侧：关闭行为等） ---------------- */
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) || {};
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
  } catch {}
}

/* ---------------- 单实例锁 ---------------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
}

// Windows 桌面通知需要 AppUserModelID，否则通知不显示/不归属
app.setAppUserModelId("com.todolist.desktop");

let win = null;
let tray = null;
let quitting = false;

/* ---------------- 主窗口 ---------------- */
function createWindow() {
  win = new BrowserWindow({
    width: 420,
    height: 700,
    minWidth: 360,
    minHeight: 520,
    title: "待办清单",
    icon: path.join(ROOT, "assets", "tray.png"),
    autoHideMenuBar: true, // 隐藏菜单栏（Alt 可临时唤出，便于开发调试）
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(ROOT, "index.html"));
  win.once("ready-to-show", () => win.show());

  // 关闭窗口行为：tray = 隐藏到托盘驻留；quit = 直接退出
  win.on("close", (e) => {
    const behavior = loadConfig().closeBehavior || "tray";
    if (!quitting && behavior === "tray") {
      e.preventDefault();
      win.hide();
      if (tray) tray.displayBalloon({ title: "待办清单", content: "已最小化到托盘，仍在后台运行提醒。" });
    }
  });

  win.on("closed", () => {
    win = null;
  });
}

function showWindow() {
  if (!win) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/* ---------------- 托盘 ---------------- */
function createTray() {
  const icon = nativeImage.createFromPath(path.join(ROOT, "assets", "tray.png"));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("待办清单");

  const menu = Menu.buildFromTemplate([
    {
      label: "显示 / 隐藏主窗口",
      click: () => {
        if (!win) createWindow();
        else if (win.isVisible()) win.hide();
        else showWindow();
      },
    },
    { type: "separator" },
    {
      label: "新建任务",
      click: () => {
        showWindow();
        if (win) win.webContents.send("tray-new-task");
      },
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);

  // 单击托盘图标：唤起主窗口
  tray.on("click", () => showWindow());
}

/* ---------------- IPC ---------------- */
ipcMain.handle("cfg-get", () => loadConfig());

ipcMain.handle("cfg-set", (_e, key, value) => {
  const cfg = loadConfig();
  cfg[key] = value;
  saveConfig(cfg);
  return true;
});

ipcMain.handle("app-version", () => ({
  app: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
}));

// 桌面通知：是否发送由渲染层（通知开关）决定，主进程只管展示
ipcMain.on("notify", (_e, title, body) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: String(title || "待办清单"),
    body: String(body || ""),
    silent: true,
  });
  n.on("click", () => showWindow());
  n.show();
});

/* ---------------- 生命周期 ---------------- */
app.whenReady().then(() => {
  createWindow();
  createTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  quitting = true;
});

app.on("window-all-closed", () => {
  // 托盘驻留时窗口只是隐藏不会触发此事件；真正关闭所有窗口即退出
  if (process.platform !== "darwin") app.quit();
});
