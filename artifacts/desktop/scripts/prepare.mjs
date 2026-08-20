// Builds the API server bundle and the frontend, then stages both under
// artifacts/desktop/resources/ so electron-builder's `extraResources` can
// pick them up. Run via `pnpm run prepare-resources` (or implicitly by
// `pnpm run dev` / `pnpm run dist`).
//
// Frontend is built with BASE_PATH="/" and no VITE_API_BASE_URL: the
// desktop app serves the dashboard and the API from the same local
// Express server (see electron-main.cjs + app.ts's LABYRINTH_STATIC_DIR),
// so everything is same-origin at the app's own root, same as local dev.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const rootDir = path.resolve(desktopDir, "../..");
const apiServerDir = path.join(rootDir, "artifacts/api-server");
const frontendDir = path.join(rootDir, "artifacts/labyrinthv8");
const resourcesDir = path.join(desktopDir, "resources");

function run(cwd, command, args, env = {}) {
  console.log(`\n> (${path.relative(rootDir, cwd) || "."}) ${command} ${args.join(" ")}`);
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...env },
    shell: process.platform === "win32",
  });
}

console.log("Building LabyrinthV8 API server bundle...");
run(apiServerDir, "pnpm", ["run", "build"]);

console.log("\nBuilding LabyrinthV8 dashboard (same-origin, for local Electron use)...");
run(frontendDir, "pnpm", ["run", "build"], {
  // Vite requires PORT to be set even for a production build (see
  // vite.config.ts) even though the dev-server port itself is unused here.
  PORT: "5173",
  BASE_PATH: "/",
  VITE_API_BASE_URL: "",
});

rmSync(resourcesDir, { recursive: true, force: true });
mkdirSync(path.join(resourcesDir, "server"), { recursive: true });
mkdirSync(path.join(resourcesDir, "dashboard"), { recursive: true });

const serverDist = path.join(apiServerDir, "dist");
const frontendDist = path.join(frontendDir, "dist", "public");

if (!existsSync(path.join(serverDist, "index.mjs"))) {
  throw new Error(`Expected build output at ${serverDist}/index.mjs — build failed?`);
}
if (!existsSync(path.join(frontendDist, "index.html"))) {
  throw new Error(`Expected build output at ${frontendDist}/index.html — build failed?`);
}

cpSync(serverDist, path.join(resourcesDir, "server"), { recursive: true });
cpSync(frontendDist, path.join(resourcesDir, "dashboard"), { recursive: true });

console.log(`\nStaged server -> ${path.relative(rootDir, path.join(resourcesDir, "server"))}`);
console.log(`Staged dashboard -> ${path.relative(rootDir, path.join(resourcesDir, "dashboard"))}`);
console.log("\nDone. Run `pnpm run dev` to launch, or `pnpm run dist` to build an installer.");
