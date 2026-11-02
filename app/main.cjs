// The Desk as an installed app (Mac and Windows), for anyone, not just Diogo. It runs the same Desk
// server inside itself, keeps this person's data in their own folder, and on first start walks
// them through their name, installing Claude Code and signing in to Claude.
const { app, BrowserWindow, Notification, nativeImage, shell, ipcMain, Menu, Tray, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFile, execFileSync, spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const WIN = process.platform === "win32", MAC = process.platform === "darwin";
const CODE = path.join(__dirname, "..");             // server.mjs, lib/, bin/, hooks/, web/
const HOME = os.homedir();
// DESK_APP_SANDBOX=<folder>: a trial run that keeps everything it writes (data, launchers, Claude
// hook settings) in that folder and uses another port, so it never touches a real Desk on this computer.
const SANDBOX = process.env.DESK_APP_SANDBOX || "";
if (SANDBOX) app.setPath("userData", path.join(SANDBOX, "data"));
const DATA = app.getPath("userData");                 // Mac: ~/Library/Application Support/Desk · Windows: %APPDATA%\Desk
const CONFIG = path.join(DATA, "config.json");
const PORT = SANDBOX ? 4796 : 4848, URL_ = `http://127.0.0.1:${PORT}`;
const BIN = SANDBOX ? path.join(SANDBOX, "bin") : path.join(HOME, ".local", "bin"); // where Claude Code puts `claude`; the `desk` launchers go next to it
const SETTINGS = SANDBOX ? path.join(SANDBOX, "claude-settings.json") : path.join(HOME, ".claude", "settings.json");
const PKG = require(path.join(CODE, "package.json"));
fs.mkdirSync(DATA, { recursive: true });

// Everything the server prints goes to desk.log in the data folder.
const logFile = fs.createWriteStream(path.join(DATA, "desk.log"), { flags: "a" });
for (const k of ["log", "warn", "error"]) { const orig = console[k]; console[k] = (...a) => { logFile.write(`${new Date().toISOString()} ${a.join(" ")}\n`); orig(...a); }; }

// Apps opened from the Dock get a bare PATH on the Mac; take the one the person's terminal has.
if (MAC) try { const p = execFileSync(process.env.SHELL || "/bin/zsh", ["-ilc", "printf %s \"$PATH\""], { encoding: "utf8", timeout: 5000 }).trim(); if (p) process.env.PATH = p; } catch {}
process.env.PATH = [BIN, path.join(HOME, ".local", "bin"), process.env.PATH].join(path.delimiter);

const config = () => { try { return JSON.parse(fs.readFileSync(CONFIG, "utf8")); } catch { return null; } };
const exists = (f) => { try { fs.accessSync(f, WIN ? fs.constants.F_OK : fs.constants.X_OK); return true; } catch { return false; } };
function findClaude() {
  const exe = WIN ? "claude.exe" : "claude";
  return [path.join(BIN, exe), ...(process.env.PATH || "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, exe)), ...(MAC ? ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"] : [])].find(exists) || null;
}
const run = (file, args, opts = {}) => new Promise((resolve) => execFile(file, args, { encoding: "utf8", timeout: 20000, windowsHide: true, ...opts }, (err, out, errOut) => resolve({ ok: !err, out: (out || "").trim(), err: (errOut || "").trim() })));

async function status() {
  const claude = findClaude();
  let version = null, auth = null;
  if (claude) {
    version = (await run(claude, ["--version"])).out.replace(/\s*\(Claude Code\)/, "") || null;
    const r = await run(claude, ["auth", "status", "--json"]);
    try { const j = JSON.parse(r.out); auth = { loggedIn: !!j.loggedIn, email: j.email || "", plan: j.subscriptionType || "", method: j.authMethod || "" }; } catch { auth = { loggedIn: false }; }
  }
  // Claude Code on Windows needs Git for Windows (its Bash).
  const git = WIN ? (await run("where", ["git"])).ok : true;
  return { name: config()?.name || "", claude: claude ? { path: claude, version } : null, auth, git, platform: process.platform };
}

// Runs a step and streams what it prints to the setup window.
function stream(win, file, args, opts = {}) {
  return new Promise((resolve) => {
    const c = spawn(file, args, { windowsHide: true, ...opts });
    const say = (d) => win?.webContents.send("log", d.toString());
    c.stdout?.on("data", say); c.stderr?.on("data", say);
    c.on("error", (e) => { say(e.message + "\n"); resolve(1); });
    c.on("close", (code) => resolve(code ?? 1));
  });
}

// The `desk` command and the Claude Code hook, for every session on this computer: small launchers
// in ~/.local/bin that run the Desk's scripts with this app as Node. Written at every start, since
// an update can move the app.
function writeLaunchers() {
  fs.mkdirSync(BIN, { recursive: true });
  const exe = process.execPath, fwd = (p) => p.replace(/\\/g, "/");
  for (const [name, script] of [["desk", "bin/desk.mjs"], ["desk-hook", "hooks/desk-hook.mjs"]]) {
    const js = path.join(CODE, script);
    fs.writeFileSync(path.join(BIN, name), `#!/bin/sh\n# Written by the Desk app. It runs ${script} with the app as Node.\nELECTRON_RUN_AS_NODE=1 DESK_HOME="${fwd(DATA)}" DESK_APP="${fwd(exe)}" DESK_PORT=${PORT} exec "${fwd(exe)}" "${fwd(js)}" "$@"\n`, { mode: 0o755 });
    if (WIN) fs.writeFileSync(path.join(BIN, name + ".cmd"), `@echo off\r\nrem Written by the Desk app. It runs ${script} with the app as Node.\r\nset ELECTRON_RUN_AS_NODE=1\r\nset "DESK_HOME=${DATA}"\r\nset "DESK_APP=${exe}"\r\nset DESK_PORT=${PORT}\r\n"${exe}" "${js}" %*\r\n`);
  }
}

// Claude Code runs the hook at the start and end of every session (see hooks/desk-hook.mjs).
function registerHooks() {
  const file = SETTINGS;
  let s = {}; try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  const command = `"${path.join(BIN, "desk-hook").replace(/\\/g, "/")}"`;
  s.hooks ||= {};
  for (const ev of ["SessionStart", "Stop"]) {
    const groups = (s.hooks[ev] ||= []);
    for (const g of groups) g.hooks = (g.hooks || []).filter((h) => !/desk-hook/.test(h.command || ""));
    s.hooks[ev] = groups.filter((g) => g.hooks.length);
    s.hooks[ev].push({ hooks: [{ type: "command", command, timeout: 10 }] });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
}

// ---- the Desk itself ----
let win = null, tray = null, server = null, quitting = false;
async function startDesk() {
  writeLaunchers();
  process.env.DESK_HOME = DATA;
  process.env.DESK_PORT = String(PORT);
  process.env.DESK_APP = process.execPath;
  const claude = findClaude(); if (claude) process.env.DESK_CLAUDE = claude;
  if (!server) {
    server = await import(pathToFileURL(path.join(CODE, "server.mjs")).href);
    server.desk.notify = (title, body) => { const n = new Notification({ title, body }); n.on("click", () => showWindow()); n.show(); };
    server.desk.thumbnail = (file) => nativeImage.createThumbnailFromPath(file, { width: 600, height: 600 }).then((img) => img.toPNG());
    server.desk.restart = () => { app.relaunch(); quitting = true; app.exit(0); };
  }
  for (let i = 0; i < 50; i++) { try { const r = await fetch(URL_ + "/api/state"); if (r.ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  win.loadURL(URL_);
}

function showWindow() { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 720, minHeight: 500, title: "Desk", backgroundColor: "#f5f5f7",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  // Links to anything but the Desk open in the normal browser; the Desk's own pages (files) in a window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(URL_)) return { action: "allow" };
    shell.openExternal(url); return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith(URL_) && !url.startsWith("file:")) { e.preventDefault(); shell.openExternal(url); } });
  // Closing the window keeps the Desk running (replies, notifications, long jobs); quit from the menu.
  win.on("close", (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  if (config()?.name && findClaude()) startDesk();
  else win.loadFile(path.join(__dirname, "setup.html"));
}

// ---- first start ----
ipcMain.handle("status", () => status());
ipcMain.handle("install-claude", () => WIN
  ? stream(win, "powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://claude.ai/install.ps1 | iex"])
  : stream(win, "/bin/bash", ["-c", "curl -fsSL https://claude.ai/install.sh | bash"]));
ipcMain.handle("install-git", () => stream(win, "winget", ["install", "--id", "Git.Git", "-e", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements"]));
ipcMain.handle("sign-in", async () => {
  const claude = findClaude(); if (!claude) return false;
  // `claude auth login` opens the browser and waits for the sign-in to finish.
  stream(win, claude, ["auth", "login", "--claudeai"], { stdio: ["ignore", "pipe", "pipe"] });
  for (let i = 0; i < 300; i++) { await new Promise((r) => setTimeout(r, 2000)); if ((await status()).auth?.loggedIn) return true; }
  return false;
});
ipcMain.handle("open-link", (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
ipcMain.handle("finish", async (_e, name) => {
  name = String(name || "").trim().slice(0, 40);
  if (!name) return false;
  fs.writeFileSync(CONFIG, JSON.stringify({ ...(config() || {}), name }, null, 2) + "\n");
  registerHooks();
  if (!SANDBOX) app.setLoginItemSettings({ openAtLogin: true });
  await startDesk();
  return true;
});

// ---- updates: a newer release on GitHub is offered, not forced ----
async function checkUpdates(manual) {
  const repo = PKG.deskRepo; if (!repo) return;
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { "User-Agent": "Desk" } });
    // A private repo answers 404 without a sign-in: show its releases in the browser, where he's signed in.
    if (r.status === 404) { if (manual) shell.openExternal(`https://github.com/${repo}/releases`); return; }
    if (!r.ok) throw new Error(`GitHub said ${r.status}`);
    const rel = await r.json(), latest = String(rel.tag_name || "").replace(/^v/, "");
    const newer = latest.split(".").map(Number).reduce((d, n, i) => d || Math.sign(n - (+app.getVersion().split(".")[i] || 0)), 0) > 0;
    if (newer) {
      const { response } = await dialog.showMessageBox(win, { type: "info", buttons: ["Download", "Later"], defaultId: 0, message: `Desk ${latest} is out`, detail: `You have ${app.getVersion()}. Download it, then open the file and replace the old Desk. Your projects and chats stay.` });
      if (response === 0) shell.openExternal(rel.html_url);
    } else if (manual) dialog.showMessageBox(win, { message: "The Desk is up to date", detail: `Version ${app.getVersion()}.` });
  } catch (e) { if (manual) dialog.showMessageBox(win, { type: "warning", message: "Couldn't check for updates", detail: e.message }); }
}

// ---- app ----
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => showWindow());
  app.whenReady().then(() => {
    const quit = () => { quitting = true; app.quit(); };
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(MAC ? [{ role: "appMenu", submenu: [{ role: "about" }, { label: "Check for updates…", click: () => checkUpdates(true) }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { label: "Quit Desk", accelerator: "Cmd+Q", click: quit }] }] : [{ label: "Desk", submenu: [{ label: "Check for updates…", click: () => checkUpdates(true) }, { label: "Data folder", click: () => shell.openPath(DATA) }, { type: "separator" }, { label: "Quit Desk", click: quit }] }]),
      { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" },
    ]));
    if (!MAC) { // Windows: the Desk keeps running in the tray when its window is closed
      tray = new Tray(nativeImage.createFromPath(path.join(__dirname, "icon.png")).resize({ width: 16, height: 16 }));
      tray.setToolTip("Desk");
      tray.setContextMenu(Menu.buildFromTemplate([{ label: "Open Desk", click: showWindow }, { label: "Quit Desk", click: quit }]));
      tray.on("click", showWindow);
    }
    createWindow();
    setTimeout(() => checkUpdates(false), 15000);
  });
  app.on("activate", () => showWindow());
  app.on("before-quit", () => { quitting = true; });
}
