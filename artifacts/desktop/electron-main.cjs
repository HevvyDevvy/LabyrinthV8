// Electron main process for LabyrinthV8 desktop.
//
// Starts the bundled Express API server as a child process on 127.0.0.1,
// points it at the built dashboard (LABYRINTH_STATIC_DIR) so one local
// server hosts UI + API, then opens a window on it.
//
// STARTUP CONTRACT (Microsoft Store 10.1.2.10 — "must not load indefinitely"):
// every stage below is bounded, and every failure path ends in either a
// visible window or a visible error dialog that names the log file. There is
// no code path that can leave the splash screen up forever.
//
//   1. splash shows immediately (static local file, no server dependency)
//   2. server child is spawned and polled over HTTP (bounded: SERVER_TIMEOUT_MS)
//   3. main window loads; it is revealed on the FIRST of did-finish-load /
//      ready-to-show / a hard fallback timer (bounded: REVEAL_FALLBACK_MS)
//
// Everything is logged to <userData>/logs/server.log. Under MSIX/AppX that
// folder is virtualised to:
//   %LOCALAPPDATA%\Packages\<PackageFamilyName>\LocalCache\Roaming\<app>\logs\

const { app, BrowserWindow, shell, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");

// Kept from the previous revision: software compositing avoids GPU-init
// hangs on constrained/virtualised graphics. Must run before app is ready.
app.disableHardwareAcceleration();

const SERVER_TIMEOUT_MS = 20000; // server must answer HTTP within this
const REVEAL_FALLBACK_MS = 10000; // show the window anyway after this
const isDev = !app.isPackaged;

const resourcesRoot = isDev ? path.resolve(__dirname, "..") : process.resourcesPath;
const serverEntry = isDev
  ? path.resolve(__dirname, "../api-server/dist/index.mjs")
  : path.join(resourcesRoot, "server", "index.mjs");
const staticDir = isDev
  ? path.resolve(__dirname, "../labyrinthv8/dist/public")
  : path.join(resourcesRoot, "dashboard");

let serverProcess = null;
let mainWindow = null;
let splashWindow = null;
let logStream = null;
let logPath = null;
let shuttingDown = false;

// ---------------------------------------------------------------- logging --

function initLog() {
  try {
    const logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    logPath = path.join(logDir, "server.log");
    logStream = fs.createWriteStream(logPath, { flags: "a" });
    logStream.on("error", () => {}); // logging must never take the app down
  } catch {
    logStream = null; // still run without a log rather than fail to start
  }
}

function log(message) {
  try {
    if (logStream) logStream.write(`[main ${new Date().toISOString()}] ${message}\n`);
    if (isDev) console.log(message);
  } catch {
    /* ignore */
  }
}

process.on("uncaughtException", (err) => log(`uncaughtException: ${err && err.stack ? err.stack : err}`));
process.on("unhandledRejection", (err) => log(`unhandledRejection: ${err && err.stack ? err.stack : err}`));

// ----------------------------------------------------------------- server --

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Polls the real HTTP stack, not just the TCP port. ANY HTTP response
// (even a 404/500) proves Express is up; only connection errors retry.
function waitForServer(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let cancelled = false;
  const promise = new Promise((resolve, reject) => {
    const retry = () => {
      if (cancelled) return;
      if (Date.now() > deadline) {
        reject(new Error(`Local server did not respond on port ${port} within ${timeoutMs / 1000}s.`));
      } else {
        setTimeout(tryOnce, 200);
      }
    };
    const tryOnce = () => {
      if (cancelled) return;
      let settled = false;
      const req = http.get(
        { host: "127.0.0.1", port, path: "/api/healthz", timeout: 2000 },
        (res) => {
          res.resume();
          if (settled) return;
          settled = true;
          resolve();
        },
      );
      req.on("timeout", () => req.destroy());
      req.on("error", () => {
        if (settled) return;
        settled = true;
        retry();
      });
    };
    tryOnce();
  });
  return { promise, cancel: () => { cancelled = true; } };
}

async function startServer() {
  if (!fs.existsSync(serverEntry)) {
    throw new Error(`Bundled server not found at ${serverEntry}.`);
  }
  const port = await findFreePort();
  const dataDir = path.join(app.getPath("userData"), "data");
  fs.mkdirSync(dataDir, { recursive: true });

  log(`--- launch --- packaged=${app.isPackaged} version=${app.getVersion()}`);
  log(`execPath: ${process.execPath}`);
  log(`serverEntry: ${serverEntry}`);
  log(`staticDir: ${staticDir} (exists=${fs.existsSync(staticDir)})`);
  log(`dataDir: ${dataDir}`);
  log(`port: ${port}`);

  // Keep the tail of the child's output so a failure dialog can show the
  // actual reason instead of just "see the log".
  let tail = "";
  const capture = (chunk) => {
    const text = chunk.toString();
    tail = (tail + text).slice(-1500);
    if (logStream) logStream.write(text);
    if (isDev) process.stdout.write(text);
  };

  serverProcess = spawn(process.execPath, [serverEntry], {
    // cwd inside userData: the package install dir is read-only under MSIX.
    cwd: dataDir,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "production",
      LABYRINTH_DATA_DIR: dataDir,
      LABYRINTH_WATCH_DIR: path.join(dataDir, "watch"),
      LABYRINTH_STATIC_DIR: staticDir,
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  log(`server spawned pid=${serverProcess.pid}`);
  serverProcess.stdout.on("data", capture);
  serverProcess.stderr.on("data", capture);

  // Rejects if the child fails to spawn or exits for ANY reason before it
  // has answered HTTP (including exit code 0 / killed by signal, which the
  // previous version silently ignored).
  const died = new Promise((_, reject) => {
    serverProcess.once("error", (err) => {
      log(`server spawn error: ${err.stack || err.message}`);
      reject(new Error(`Failed to launch server process: ${err.message}`));
    });
    serverProcess.once("exit", (code, signal) => {
      log(`server exited code=${code} signal=${signal}`);
      reject(new Error(`Server exited during startup (code ${code}${signal ? `, signal ${signal}` : ""}).`));
    });
  });

  const ready = waitForServer(port, SERVER_TIMEOUT_MS);
  try {
    await Promise.race([ready.promise, died]);
  } catch (err) {
    ready.cancel();
    log(`startup failed: ${err.message}\n--- server output tail ---\n${tail}\n--------------------------`);
    const detail = tail.trim() ? `\n\nServer output:\n${tail.trim().slice(-600)}` : "";
    throw new Error(`${err.message}${detail}`);
  }
  log("server is answering HTTP");
  return port;
}

// ---------------------------------------------------------------- windows --

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 360,
    height: 360,
    frame: false,
    resizable: false,
    backgroundColor: "#10161c",
    show: true,
    webPreferences: { contextIsolation: true },
  });
  splashWindow.loadFile(path.join(__dirname, "splash.html")).catch((err) => log(`splash load failed: ${err.message}`));
}

function setSplashStatus(text) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents
      .executeJavaScript(`window.setSplashStatus && window.setSplashStatus(${JSON.stringify(text)})`)
      .catch(() => {});
  }
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
  splashWindow = null;
}

function fatal(err) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`FATAL: ${err.stack || err.message}`);
  closeSplash();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  dialog.showErrorBox(
    "LabyrinthV8 failed to start",
    `${err.message}\n\n${logPath ? `Log file: ${logPath}` : "No log file could be created."}`,
  );
  app.quit();
}

async function createWindow() {
  createSplashWindow();
  setSplashStatus("Starting local security server…");

  const port = await startServer(); // throws with a real message on failure

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: "LabyrinthV8",
    backgroundColor: "#0b0d12",
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Idempotent reveal. Handlers are registered BEFORE loadURL (the previous
  // version registered ready-to-show only AFTER `await loadURL`, so if the
  // event had already fired the window was never shown and the splash never
  // closed — an unbounded wait with no error, exactly "loads indefinitely").
  let revealed = false;
  let fallbackTimer = null;
  const reveal = (why) => {
    if (revealed || !mainWindow || mainWindow.isDestroyed()) return;
    revealed = true;
    clearTimeout(fallbackTimer);
    log(`revealing main window (${why})`);
    closeSplash();
    mainWindow.show();
    mainWindow.focus();
  };

  mainWindow.webContents.once("did-finish-load", () => reveal("did-finish-load"));
  mainWindow.once("ready-to-show", () => reveal("ready-to-show"));
  fallbackTimer = setTimeout(() => reveal(`fallback after ${REVEAL_FALLBACK_MS}ms`), REVEAL_FALLBACK_MS);

  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    log(`did-fail-load code=${code} desc=${desc} url=${url} mainFrame=${isMainFrame}`);
    if (!isMainFrame || code === -3 /* ERR_ABORTED */ || revealed) return;
    clearTimeout(fallbackTimer);
    fatal(new Error(`Dashboard failed to load (${desc}, code ${code}).`));
  });
  mainWindow.webContents.on("render-process-gone", (_e, details) =>
    log(`render-process-gone reason=${details.reason} exitCode=${details.exitCode}`),
  );
  mainWindow.webContents.on("unresponsive", () => log("renderer unresponsive"));
  mainWindow.webContents.on("console-message", (_e, level, message, line, source) => {
    if (level >= 2) log(`renderer console[${level}] ${message} (${source}:${line})`);
  });

  setSplashStatus("Loading dashboard…");
  log(`loading http://127.0.0.1:${port}/`);
  mainWindow.loadURL(`http://127.0.0.1:${port}/`).catch((err) => {
    log(`loadURL rejected: ${err.message}`);
    // ERR_ABORTED etc. are reported via did-fail-load; the timer still guards us.
  });
}

// -------------------------------------------------------------- lifecycle --

app.whenReady().then(() => {
  initLog();
  createWindow().catch(fatal);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow().catch(fatal);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  shuttingDown = true;
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
});
