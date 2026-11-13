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
  session,
  shell,
} = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const CONFIG_FILE = path.join(app.getPath("userData"), "config.json");

/* ---------------- 配置持久化（主进程侧：关闭行为等） ---------------- */
function loadConfig() {
  try {
    // 容忍 UTF-8 BOM（外部工具写入的 JSON 可能带头，解析失败会触发配置被清空重写）
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8").replace(/^\uFEFF/, "")) || {};
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

/* ---------------- 授权流程调试日志 ----------------
 * 默认关闭：正式版不把 token / userinfo 落盘。
 * 排查登录问题时在 userData/config.json 里加 "authDebug": true 再启动。
 */
function authLog(file, s) {
  if (!loadConfig().authDebug) return;
  try {
    fs.appendFileSync(path.join(app.getPath("userData"), file), new Date().toISOString() + " " + s + "\n");
  } catch {}
}

/* ---------------- 应用数据持久化（渲染层存储，替代 localStorage） ---------------- */
const DATA_FILE = path.join(app.getPath("userData"), "todolist-data.json");

function readData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeData(json) {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, json, "utf8");
    try {
      fs.renameSync(tmp, DATA_FILE);
    } catch {
      // rename 被占用时退回直接写
      fs.rmSync(tmp, { force: true });
      fs.writeFileSync(DATA_FILE, json, "utf8");
    }
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
    width: 460,
    height: 700,
    minWidth: 420,
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

/* ---------------- 华为账号 OAuth2.0 网页登录 ----------------
 * 与鸿蒙版共用 AGC 应用 client_id；内嵌授权窗拦截回调 code，
 * PKCE(SaaS256) 在主进程换 token，解析 id_token 取 openID/昵称。
 */
const HW = {
  clientId: "6917620958699376481",
  authorizeUrl: "https://oauth-login.cloud.huawei.com/oauth2/v2/authorize",
  tokenUrl: "https://oauth-login.cloud.huawei.com/oauth2/v2/token",
  redirectUri: "https://xc-07.github.io/XCTodoList/hw-callback", // GitHub Pages 域名回调，由主进程拦截
  scope: "openid profile",
};

// 华为 SaaS256：对 SHA256(code_verifier) 的 base64url 做自定义字符映射
function saas256(verifier) {
  const b64 = crypto.createHash("sha256").update(verifier).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return b64.replace(/[A-Za-z0-9]/g, (c) => {
    if (c <= "Z") return String.fromCharCode(((c.charCodeAt(0) - 65 + 13) % 26) + 65);
    if (c <= "z") return String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97);
    return String.fromCharCode(((c.charCodeAt(0) - 48 + 2) % 10) + 48);
  });
}

function parseIdToken(jwt) {
  try {
    return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function huaweiLogin() {
  return new Promise((resolve) => {
    const state = crypto.randomBytes(16).toString("hex");
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = saas256(verifier);
    const url =
      `${HW.authorizeUrl}?response_type=code&client_id=${HW.clientId}` +
      `&scope=${encodeURIComponent(HW.scope)}&state=${state}` +
      `&redirect_uri=${encodeURIComponent(HW.redirectUri)}` +
      `&code_challenge=${challenge}&code_challenge_method=SaaS256`;

    const authWin = new BrowserWindow({
      width: 480,
      height: 640,
      title: "华为账号登录",
      parent: win || undefined,
      modal: !!win,
      autoHideMenuBar: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: "hwauth", // 授权窗专用会话，与主窗口隔离
      },
    });

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (!authWin.isDestroyed()) authWin.close();
      resolve(result);
    };

    const exchange = async (code) => {
      try {
        const body = new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: HW.clientId,
          redirect_uri: HW.redirectUri,
          code_verifier: verifier,
        });
        // 客户端密钥不入库（GitHub），从本地 config.json 的 hwClientSecret 读取
        const secret = loadConfig().hwClientSecret || "";
        if (secret) body.set("client_secret", secret);
        const res = await fetch(HW.tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
        const data = await res.json();
        authLog("hw-debug.log", "token: " + JSON.stringify(data).slice(0, 500));
        if (data.error) {
          return finish({ error: data.error_description || data.error });
        }
        let openID = "";
        let name = "";
        let picture = "";
        if (data.id_token) {
          const claims = parseIdToken(data.id_token);
          openID = claims.sub || claims.openID || claims.open_id || "";
          name = claims.nickName || claims.nick_name || claims.name || "";
          picture = claims.picture || claims.avatar || "";
        }
        if (!openID && data.access_token) {
          // 华为 token 响应不带 id_token 时，用 userinfo 接口取基本资料
          const res2 = await fetch("https://account.cloud.huawei.com/rest.php?nsp_svc=GOpen.User.getInfo", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ access_token: data.access_token }),
          });
          const info = await res2.json();
          authLog("hw-debug.log", "userinfo: " + JSON.stringify(info).slice(0, 500));
          openID = info.openID || info.unionID || "";
          name = info.displayName || "";
          picture = info.headPictureURL || "";
          if (picture.startsWith("//")) picture = "https:" + picture;
        }
        if (!openID) return finish({ error: "未能从授权结果中解析 openID" });
        // 附带华为凭证：id_token（JWKS 可验签）或 access_token（服务端复核），供换 Supabase 会话
        finish({
          openID, name, picture,
          idToken: data.id_token || "",
          accessToken: data.access_token || "",
        });
      } catch (e) {
        finish({ error: "网络错误：" + (e.message || e) });
      }
    };

    const hwLog = (s) => authLog("hw-debug.log", s);

    authWin.webContents.on("will-navigate", (_e, navUrl) => {
      if (!navUrl.startsWith(HW.redirectUri)) return;
      _e.preventDefault();
      hwLog("intercepted: " + navUrl);
      const u = new URL(navUrl);
      // 华为可能把参数放在 query 或 # 片段里，两处都取
      const params = new URLSearchParams(u.search ? u.search.slice(1) : u.hash.replace(/^#/, ""));
      if (params.get("state") !== state) return finish({ error: "授权状态校验失败，请重试" });
      const err = params.get("error");
      if (err) return finish({ error: err });
      // 华为网页授权回调的参数名是 authorization_code（非标准 OAuth 的 code）
      const code = params.get("code") || params.get("authorization_code");
      if (!code) return finish({ error: "未获取到授权码，回调地址：" + navUrl });
      exchange(code);
    });
    // 授权页内 target=_blank 的新窗口改为当前窗口跳转
    authWin.webContents.setWindowOpenHandler(({ url: u }) => {
      if (u.startsWith(HW.redirectUri)) return { action: "allow" };
      authWin.webContents.loadURL(u);
      return { action: "deny" };
    });
    authWin.on("closed", () => finish({ error: "canceled" }));
    // 每次登录前清空授权会话：不沿用华为登录 Cookie，强制重新走完整登录流程
    session
      .fromPartition("hwauth")
      .clearStorageData()
      .finally(() => {
        if (!authWin.isDestroyed()) authWin.loadURL(url);
      });
  });
}

/* ---------------- 谷歌账号 OAuth2.0 登录（系统浏览器 + 本机回环回调） ----------------
 * Google 拒绝内嵌 webview（disallowed_useragent），桌面应用走官方推荐流：
 * 主进程起一次性 127.0.0.1 回环 HTTP 服务 → shell.openExternal 拉系统浏览器 →
 * 回调带 code 回本机 → 标准 PKCE(S256) 换 token（需带 client_secret，从 config.json 读）。
 * client_id 从本地 config.json 的 googleClientId 读取（不入库）。
 */
const GG = {
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scope: "openid profile email",
};

function googleLogin() {
  return new Promise((resolve) => {
    const clientId = loadConfig().googleClientId || "";
    if (!clientId) {
      return resolve({ error: "未配置谷歌客户端 ID（config.json 的 googleClientId）" });
    }

    const ggLog = (s) => authLog("gg-debug.log", s);

    const state = crypto.randomBytes(16).toString("hex");
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

    let settled = false;
    let server = null;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (server) {
        try { server.close(); } catch {}
        server = null;
      }
      resolve(result);
    };

    // 5 分钟未完成授权视为取消
    timer = setTimeout(() => finish({ error: "canceled" }), 5 * 60 * 1000);

    const exchange = async (code, redirectUri) => {
      try {
        const body = new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        });
        // 谷歌桌面应用客户端换 token 同样要求 client_secret（与安卓客户端不同）；
        // 密钥不入库，从本地 config.json 的 googleClientSecret 读取
        const ggSecret = loadConfig().googleClientSecret || "";
        if (ggSecret) body.set("client_secret", ggSecret);
        const res = await fetch(GG.tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
        const data = await res.json();
        ggLog("token: " + JSON.stringify(data).slice(0, 500));
        if (data.error) return finish({ error: data.error_description || data.error });
        if (!data.id_token) return finish({ error: "谷歌未返回 id_token" });
        const claims = parseIdToken(data.id_token);
        const sub = claims.sub || "";
        if (!sub) return finish({ error: "未能从 id_token 解析 sub" });
        finish({
          sub,
          name: claims.name || "",
          picture: claims.picture || "",
          email: claims.email || "",
          idToken: data.id_token,
          refreshToken: data.refresh_token || "",
        });
      } catch (e) {
        finish({ error: "网络错误：" + (e.message || e) });
      }
    };

    server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname !== "/callback") {
        res.writeHead(404);
        return res.end();
      }
      const okHtml = '<!doctype html><meta charset="utf-8"><title>待办清单</title><body style="font-family:system-ui;text-align:center;padding-top:80px"><h3>谷歌账号授权成功</h3><p>可以关闭此页面，回到待办清单。</p></body>';
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(okHtml);
      if (u.searchParams.get("state") !== state) return finish({ error: "授权状态校验失败，请重试" });
      const err = u.searchParams.get("error");
      if (err) return finish({ error: err });
      const code = u.searchParams.get("code");
      if (!code) return finish({ error: "未获取到授权码" });
      const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
      exchange(code, redirectUri);
    });

    server.on("error", (e) => finish({ error: "本机回调端口启动失败：" + (e.message || e) }));

    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      const url =
        `${GG.authorizeUrl}?response_type=code&client_id=${encodeURIComponent(clientId)}` +
        `&scope=${encodeURIComponent(GG.scope)}&state=${state}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&code_challenge=${challenge}&code_challenge_method=S256` +
        `&access_type=offline&prompt=consent`;
      ggLog("authorize: " + url.replace(/client_id=[^&]+/, "client_id=***"));
      shell.openExternal(url).catch((e) => finish({ error: "无法打开浏览器：" + (e.message || e) }));
    });
  });
}

/* ---------------- IPC ---------------- */
ipcMain.handle("hw-login", () => huaweiLogin());
ipcMain.handle("google-login", () => googleLogin());

ipcMain.on("store-read", (e) => {
  e.returnValue = readData();
});
ipcMain.on("store-write", (_e, json) => writeData(json));
ipcMain.on("store-write-sync", (e, json) => {
  writeData(json);
  e.returnValue = true;
});

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
