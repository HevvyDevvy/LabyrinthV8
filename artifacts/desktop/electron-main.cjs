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

const { app, BrowserWindow, shell } = require("electron");
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

function waitForServer(port, timeoutMs = 15000) {
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
    stdio: isDev ? "inherit" : "ignore",
  });

  serverProcess.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`LabyrinthV8 server exited unexpectedly with code ${code}`);
    }
  });

  await waitForServer(port);
  return port;
}

async function createWindow() {
  const port = await startServer();

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: "LabyrinthV8",
    backgroundColor: "#0b0d12",
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

  await mainWindow.loadURL(`http://127.0.0.1:${port}/`);
}

app.whenReady().then(() => {
  createWindow().catch((err) => {
    console.error("Failed to start LabyrinthV8:", err);
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
