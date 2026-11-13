"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// 渲染层通过 window.electronAPI 访问 Electron 能力；Web 模式下该对象不存在
contextBridge.exposeInMainWorld("electronAPI", {
  // 桌面通知
  notify(title, body) {
    ipcRenderer.send("notify", title, body);
  },

  // 版本信息（app / electron / chrome / node）
  getVersion() {
    return ipcRenderer.invoke("app-version");
  },

  // 主进程配置（关闭行为等，持久化到 userData/config.json）
  cfgGet() {
    return ipcRenderer.invoke("cfg-get");
  },
  cfgSet(key, value) {
    return ipcRenderer.invoke("cfg-set", key, value);
  },

  // 托盘菜单「新建任务」
  onTrayNewTask(cb) {
    ipcRenderer.on("tray-new-task", () => cb());
  },

  // 应用数据快照持久化（替代 localStorage，落盘 userData/todolist-data.json）
  storeRead() {
    return ipcRenderer.sendSync("store-read");
  },
  storeWrite(json) {
    ipcRenderer.send("store-write", json);
  },
  storeFlush(json) {
    return ipcRenderer.sendSync("store-write-sync", json);
  },

  // 华为账号 OAuth 登录（主进程内嵌授权窗 + PKCE 换 token）
  hwLogin() {
    return ipcRenderer.invoke("hw-login");
  },

  // 谷歌账号 OAuth 登录（主进程 loopback 回调 + 系统浏览器 + PKCE）
  googleLogin() {
    return ipcRenderer.invoke("google-login");
  },
});
