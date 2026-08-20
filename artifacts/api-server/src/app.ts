import path from "node:path";
import { existsSync } from "node:fs";
import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// CORS: locked down to an explicit allowlist rather than open to any origin.
// Set ALLOWED_ORIGINS as a comma-separated list of exact origins (scheme +
// host + port only — no path), e.g.:
//   ALLOWED_ORIGINS=https://your-user.github.io
// In non-production, common local dev origins are allowed automatically so
// `pnpm dev` keeps working without extra config.
const devDefaultOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];
const configuredOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const isProduction = process.env.NODE_ENV === "production";
const allowedOrigins = new Set([
  ...configuredOrigins,
  ...(isProduction ? [] : devDefaultOrigins),
]);

if (isProduction && allowedOrigins.size === 0) {
  logger.warn(
    "ALLOWED_ORIGINS is not set in production — all cross-origin browser requests will be rejected until it's configured.",
  );
}

app.use(
  cors({
    origin(origin, callback) {
      // No Origin header means a same-origin request or a non-browser
      // client (curl, server-to-server health checks) — always allow those.
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin not allowed: ${origin}`));
    },
  }),
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// Only used by the desktop (Electron) build: when LABYRINTH_STATIC_DIR
// points at the built React app, this same local server hosts both the
// API and the UI, so the desktop app is a single localhost origin with no
// CORS involved at all. Unset in the normal GitHub Pages + Render
// deployment, where the frontend is hosted separately.
const staticDir = process.env.LABYRINTH_STATIC_DIR;
if (staticDir && existsSync(staticDir)) {
  app.use(express.static(staticDir));
  // SPA fallback: any non-API, non-file route serves index.html so
  // client-side routing (wouter) keeps working on refresh/deep links.
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(staticDir, "index.html"));
  });
}

export default app;
