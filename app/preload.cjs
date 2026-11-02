// What the first-start screen (setup.html) may ask the app to do. The Desk's own pages don't use it.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("setup", {
  status: () => ipcRenderer.invoke("status"),
  installClaude: () => ipcRenderer.invoke("install-claude"),
  installGit: () => ipcRenderer.invoke("install-git"),
  signIn: () => ipcRenderer.invoke("sign-in"),
  finish: (name) => ipcRenderer.invoke("finish", name),
  openLink: (url) => ipcRenderer.invoke("open-link", url),
  onLog: (fn) => ipcRenderer.on("log", (_e, text) => fn(text)),
});
