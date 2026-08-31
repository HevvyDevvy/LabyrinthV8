// Electron main process.
//
// What this does, at a high level: it starts the same Express API server
// (artifacts/api-server) as a child process bound to 127.0.0.1 on a local
// port, points that server at the built React dashboard (artifacts/
// labyrinthv8) via LABYRINTH_STATIC_DIR so one local server hosts both UI
// and API, then opens a window on it. Because everything now runs on the
// user's own machine instead of GitHub Pages + Render, "full-system scan"
// in the dashboard actually walks *this* machine's drives.
//
// CommonJS (.cjs) on purpose — Electron's main process loads this directly
// with Node's CJS loader; keeping it separate from the ESM-only workspace
// avoids fighting module interop for a 100-line bootstrap script.

const { app, BrowserWindow, shell, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const net = require("node:net");

const isDev = !app.isPackaged;

// In a packaged app, extraResources land in process.resourcesPath. In dev
// (`pnpm --filter @workspace/desktop dev`), they're just the sibling
// artifacts' own dist output.
const resourcesRoot = isDev
  ? path.resolve(__dirname, "..")
  : path.join(process.resourcesPath);

const serverEntry = isDev
  ? path.resolve(__dirname, "../api-server/dist/index.mjs")
  : path.join(resourcesRoot, "server", "index.mjs");

const staticDir = isDev
  ? path.resolve(__dirname, "../labyrinthv8/dist/public")
  : path.join(resourcesRoot, "dashboard");

let serverProcess = null;
let mainWindow = null;

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

function waitForServer(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`Server did not start listening on port ${port} in time.`));
        } else {
          setTimeout(tryOnce, 150);
        }
      });
    };
    tryOnce();
  });
}

async function startServer() {
  if (!fs.existsSync(serverEntry)) {
    throw new Error(
      `Bundled server not found at ${serverEntry}. Run the build script ` +
        `(artifacts/desktop/scripts/prepare.mjs) before starting the desktop app.`,
    );
  }

  const port = await findFreePort();
  const userDataDir = app.getPath("userData");
  const dataDir = path.join(userDataDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });

  // Always capture server output to a log file — NOT just in dev. The
  // earlier "ignore" here in production meant any crash reason from the
  // spawned server was thrown away, which is why cert failures came back
  // with "Error Message: N/A". This is the single most useful line in
  // this file for diagnosing a launch failure on a machine you don't
  // control.
  const logDir = path.join(userDataDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, "server.log");
  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  logStream.write(`\n--- launch ${new Date().toISOString()} ---\n`);
  logStream.write(`serverEntry: ${serverEntry}\n`);
  logStream.write(`staticDir: ${staticDir}\n`);
  logStream.write(`port: ${port}\n`);

  serverProcess = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "production",
      LABYRINTH_DATA_DIR: dataDir,
      LABYRINTH_WATCH_DIR: path.join(dataDir, "watch"),
      LABYRINTH_STATIC_DIR: staticDir,
      // Same-origin (Electron loads http://127.0.0.1:<port>/ directly), so
      // no cross-origin requests occur and ALLOWED_ORIGINS can stay unset.
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  serverProcess.stdout.pipe(logStream, { end: false });
  serverProcess.stderr.pipe(logStream, { end: false });
  if (isDev) {
    serverProcess.stdout.pipe(process.stdout);
    serverProcess.stderr.pipe(process.stderr);
  }

  let earlyExitError = null;
  serverProcess.on("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      earlyExitError = new Error(
        `Server exited with code ${code}${signal ? ` (signal ${signal})` : ""}. See log: ${logPath}`,
      );
      logStream.write(`[main] ${earlyExitError.message}\n`);
    }
  });

  try {
    // Fail fast if the server process dies instead of waiting the full
    // timeout — makes the real error surface in seconds, not 15s of
    // silence followed by a generic timeout message.
    await Promise.race([
      waitForServer(port),
      new Promise((_, reject) => {
        serverProcess.once("exit", (code, signal) => {
          if (code !== 0 && code !== null) {
            reject(
              earlyExitError ||
                new Error(`Server exited with code ${code}${signal ? ` (signal ${signal})` : ""}.`),
            );
          }
        });
      }),
    ]);
  } catch (err) {
    logStream.write(`[main] startup failed: ${err.stack || err.message}\n`);
    throw new Error(`${err.message} (full log: ${logPath})`);
  }

  return port;
}

let splashWindow = null;

// The splash screen has NO dependency on the server — it's a local static
// HTML file, so it shows instantly regardless of how long the server takes
// to start. This is what Microsoft's cert feedback asked for: a progress
// indicator instead of an unresponsive blank window during launch.
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
  splashWindow.loadFile(path.join(__dirname, "splash.html"));
  return splashWindow;
}

function setSplashStatus(text) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.executeJavaScript(
      `window.setSplashStatus && window.setSplashStatus(${JSON.stringify(text)})`,
    ).catch(() => {});
  }
}

async function createWindow() {
  createSplashWindow();

  let port;
  try {
    setSplashStatus("Starting local security server…");
    port = await startServer();
  } catch (err) {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    throw err;
  }

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: "LabyrinthV8",
    backgroundColor: "#0b0d12",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Open any link the dashboard opens with target=_blank in the OS browser
  // instead of a second Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  setSplashStatus("Loading dashboard…");
  await mainWindow.loadURL(`http://127.0.0.1:${port}/`);

  // Swap splash -> real window only once content has actually loaded, so
  // there's never a blank frame in between.
  mainWindow.once("ready-to-show", () => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    mainWindow.show();
  });
}

app.whenReady().then(() => {
  createWindow().catch((err) => {
    console.error("Failed to start LabyrinthV8:", err);
    dialog.showErrorBox(
      "LabyrinthV8 failed to start",
      `${err.message}\n\nIf this keeps happening, check the log file mentioned above ` +
        `(under this app's data folder → logs → server.log) and share it for support.`,
    );
    app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow().catch((err) => console.error(err));
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
  }
});
