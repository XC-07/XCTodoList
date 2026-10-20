"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// 渲染层通过 window.electronAPI 访问 Electron 能力；Web 模式下该对象不存在
contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,

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
});
