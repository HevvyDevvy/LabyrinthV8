import { createHash } from "node:crypto";
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { EnvelopeKMS, LocalDevBackend, shannonEntropy } from "./envelope";

export type Severity = "critical" | "warning" | "info";
export type RequestStatus = "pending" | "approved" | "denied";

export type SecurityAlert = {
  id: string;
  kind: string;
  path: string;
  detail: string;
  severity: Severity;
  timestamp: string;
};

export type ProtectionRequest = {
  id: string;
  path: string;
  reason: string;
  status: RequestStatus;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  encryptedTo: string | null;
};

export type AuditEvent = {
  id: string;
  timestamp: string;
  action: string;
  target: string;
  actor: string;
  detail: string;
  hash: string;
};

type PersistedState = {
  alerts: SecurityAlert[];
  requests: ProtectionRequest[];
  auditEvents: AuditEvent[];
  lastScan: string | null;
  snapshot: Record<string, { mtimeMs: number; size: number }>;
};

const dataDir = path.resolve(process.env.LABYRINTH_DATA_DIR ?? "data");
const statePath = path.join(dataDir, "labyrinth-state.json");
const watchDir = path.resolve(
  process.env.LABYRINTH_WATCH_DIR ?? path.join(dataDir, "watch"),
);
const scanIntervalMs =
  Math.max(10, Number(process.env.LABYRINTH_SCAN_INTERVAL_SECONDS ?? 15)) * 1000;
const keystorePath = path.join(dataDir, "keystore.json");
const kms = new EnvelopeKMS(new LocalDevBackend(keystorePath));
const ENTROPY_HIGH_THRESHOLD = 7.5; // bits/byte; random/encrypted data is ~7.9-8.0

const patterns = {
  SSN: /\b\d{3}-\d{2}-\d{4}\b/,
  CREDIT_CARD: /\b(?:\d[ -]*?){13,16}\b/,
  US_ROUTING_NUMBER: /\b\d{9}\b/,
};
const keywords = [
  "patient",
  "diagnosis",
  "prescription",
  "confidential",
  "privileged",
  "classified",
  "protected health information",
  "phi",
  "attorney-client",
  "social security",
  "date of birth",
];
// Word-boundary regexes, not plain substring search. A raw .includes("phi")
// matches inside ordinary words like "philosophy" or "sophisticated" — fine
// for one small watched folder, but at full-system scale (hundreds of
// thousands of files) that noise buries every real hit in false positives.
const keywordPatterns = keywords.map(
  (keyword) => new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
);
const suspiciousExtensions = new Set([
  ".locked",
  ".encrypted",
  ".enc",
  ".crypt",
  ".ryk",
  ".wncry",
]);


let state: PersistedState = {
  alerts: [],
  requests: [],
  auditEvents: [],
  lastScan: null,
  snapshot: {},
};
let started = false;

const now = () => new Date().toISOString();
const id = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

async function save() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), {
    mode: 0o600,
  });
}

async function load() {
  try {
    const contents = await fs.readFile(statePath, "utf8");
    state = JSON.parse(contents) as PersistedState;
  } catch {
    await save();
  }
}

function addAudit(
  action: string,
  target: string,
  actor: string,
  detail: string,
) {
  const previous = state.auditEvents[0]?.hash ?? "GENESIS";
  const timestamp = now();
  const hash = createHash("sha256")
    .update(`${previous}|${timestamp}|${action}|${target}|${actor}|${detail}`)
    .digest("hex");
  state.auditEvents.unshift({
    id: id("evt"),
    timestamp,
    action,
    target,
    actor,
    detail,
    hash,
  });
}

function addAlert(
  kind: string,
  target: string,
  detail: string,
  severity: Severity,
) {
  const duplicate = state.alerts.find(
    (alert) =>
      alert.kind === kind &&
      alert.path === target &&
      Date.now() - new Date(alert.timestamp).getTime() < 15 * 60_000,
  );
  if (duplicate) return;
  state.alerts.unshift({
    id: id("alert"),
    kind,
    path: target,
    detail,
    severity,
    timestamp: now(),
  });
  state.alerts = state.alerts.slice(0, 200);
  addAudit("ALERT", target, "labyrinthv8-monitor", `${kind}: ${detail}`);
}

// Directories that are either pseudo/virtual filesystems (no real files,
// can hang or error on read), pure noise for a sensitive-data sweep, or so
// large/binary that walking them wastes an entire full-system scan for zero
// signal. Matched by exact folder name anywhere in the tree.
const excludedDirNames = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  "site-packages",
  ".cache",
  ".npm",
  ".cargo",
  ".rustup",
  "$RECYCLE.BIN",
  "System Volume Information",
]);
// POSIX pseudo/virtual filesystems — not real user data, can be huge or
// unreadable, and walking them provides no sensitive-data signal.
const excludedAbsDirsPosix = [
  "/proc",
  "/sys",
  "/dev",
  "/run",
  "/snap",
  "/var/lib/docker",
  "/lost+found",
];

/** Best-effort top-level roots that make up "the whole system" on this
 * platform. Windows: every mounted drive letter. Everything else: "/". This
 * is a starting point, not a guarantee — review it for your environment. */
export async function getSystemRoots(): Promise<string[]> {
  if (process.platform !== "win32") return ["/"];
  const roots: string[] = [];
  for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    const drive = `${letter}:\\`;
    try {
      await fs.stat(drive);
      roots.push(drive);
    } catch {
      // Drive letter not in use — skip.
    }
  }
  return roots.length ? roots : ["C:\\"];
}

export type ScanProgress = {
  running: boolean;
  roots: string[];
  filesScanned: number;
  dirsSkipped: number;
  hitsFound: number;
  currentPath: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
};

let fullScanProgress: ScanProgress = {
  running: false,
  roots: [],
  filesScanned: 0,
  dirsSkipped: 0,
  hitsFound: 0,
  currentPath: "",
  startedAt: null,
  finishedAt: null,
  error: null,
};
let fullScanCancelled = false;

export function getFullScanStatus(): ScanProgress {
  return fullScanProgress;
}

export function cancelFullSystemScan(): boolean {
  if (!fullScanProgress.running) return false;
  fullScanCancelled = true;
  return true;
}

function isExcludedDir(dirPath: string, name: string): boolean {
  if (excludedDirNames.has(name)) return true;
  const abs = path.join(dirPath, name);
  return excludedAbsDirsPosix.some(
    (excluded) => abs === excluded || abs.startsWith(excluded + path.sep),
  );
}

/** Classifies one file for the request queue without touching persisted
 * snapshot/entropy state — used by the one-off full-system scan, which
 * intentionally doesn't try to track change-over-time for the whole disk. */
async function classifyFile(filePath: string): Promise<void> {
  const isOwnOutput = filePath.endsWith(".enc") || filePath.endsWith(".meta.json");
  if (isOwnOutput) return;

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return;
  }
  if (!stat.isFile() || stat.size > 2_000_000) return;

  try {
    const contents = await fs.readFile(filePath, "utf8");
    const matchedPatterns = Object.entries(patterns)
      .filter(([, pattern]) => pattern.test(contents))
      .map(([name]) => name);
    const matchedKeywords = keywords.filter((_keyword, index) =>
      keywordPatterns[index].test(contents),
    );
    if (!matchedPatterns.length && !matchedKeywords.length) return;

    const reason = [
      matchedPatterns.length ? `Matched ${matchedPatterns.join(", ")}` : "",
      matchedKeywords.length ? `keywords: ${matchedKeywords.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; ");

    if (state.requests.some((item) => item.path === filePath && item.status === "pending")) {
      return;
    }
    const request: ProtectionRequest = {
      id: id("req"),
      path: filePath,
      reason,
      status: "pending",
      createdAt: now(),
      decidedAt: null,
      decidedBy: null,
      encryptedTo: null,
    };
    state.requests.unshift(request);
    fullScanProgress.hitsFound += 1;
    addAudit(
      "SCAN_HIT",
      filePath,
      "labyrinthv8-full-scan",
      "Sensitive content detected during full-system scan; human review required.",
    );
  } catch {
    // Binary or unreadable file — not a text match, safe to skip.
  }
}

async function walkForFullScan(root: string): Promise<void> {
  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    // Permission denied, gone mid-scan, not a real directory, etc. — this
    // is *expected and routine* on a full-disk walk, so count it and move
    // on instead of letting one bad directory abort the entire scan.
    fullScanProgress.dirsSkipped += 1;
    return;
  }

  for (const entry of entries) {
    if (fullScanCancelled) return;
    if (entry.isSymbolicLink()) continue; // avoid symlink loops
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (isExcludedDir(root, entry.name)) continue;
      await walkForFullScan(fullPath);
    } else if (entry.isFile()) {
      fullScanProgress.filesScanned += 1;
      fullScanProgress.currentPath = fullPath;
      await classifyFile(fullPath);
    }
  }
}

/** Kicks off a one-off, cancellable scan of every filesystem root. This is
 * deliberately separate from the periodic single-directory scan() above and
 * only ever runs when a person explicitly triggers it — never on a timer —
 * because sweeping an entire disk is a much bigger action than watching one
 * chosen folder. Detection only: hits land in the same human-gated approval
 * queue as any other scan, nothing is auto-encrypted. */
export async function startFullSystemScan(
  initiator: string,
  roots?: string[],
): Promise<{ started: boolean; roots: string[] }> {
  if (fullScanProgress.running) {
    return { started: false, roots: fullScanProgress.roots };
  }
  const resolvedRoots = roots?.length ? roots : await getSystemRoots();
  fullScanCancelled = false;
  fullScanProgress = {
    running: true,
    roots: resolvedRoots,
    filesScanned: 0,
    dirsSkipped: 0,
    hitsFound: 0,
    currentPath: "",
    startedAt: now(),
    finishedAt: null,
    error: null,
  };
  addAudit("FULL_SYSTEM_SCAN_STARTED", resolvedRoots.join(", "), initiator, "");

  void (async () => {
    try {
      for (const root of resolvedRoots) {
        if (fullScanCancelled) break;
        await walkForFullScan(root);
      }
    } catch (err) {
      fullScanProgress.error = err instanceof Error ? err.message : String(err);
    } finally {
      fullScanProgress.running = false;
      fullScanProgress.finishedAt = now();
      addAudit(
        "FULL_SYSTEM_SCAN_FINISHED",
        resolvedRoots.join(", "),
        initiator,
        `${fullScanCancelled ? "Cancelled. " : ""}Scanned ${fullScanProgress.filesScanned} file(s), ${fullScanProgress.hitsFound} hit(s), ${fullScanProgress.dirsSkipped} dir(s) skipped.`,
      );
      await save();
    }
  })();

  return { started: true, roots: resolvedRoots };
}

async function walk(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "labyrinth-state.json")
      continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await walk(fullPath)));
    else paths.push(fullPath);
  }
  return paths;
}

async function scan() {
  await fs.mkdir(watchDir, { recursive: true });
  const files = await walk(watchDir);
  const nextSnapshot: PersistedState["snapshot"] = {};

  for (const filePath of files) {
    const stat = await fs.stat(filePath);
    nextSnapshot[filePath] = { mtimeMs: stat.mtimeMs, size: stat.size };
    const previous = state.snapshot[filePath];
    const changed =
      !previous ||
      previous.mtimeMs !== stat.mtimeMs ||
      previous.size !== stat.size;
    if (changed && suspiciousExtensions.has(path.extname(filePath).toLowerCase())) {
      addAlert(
        "SUSPICIOUS_EXTENSION",
        filePath,
        `File uses a known ransomware-style extension '${path.extname(filePath)}'. Content was not changed.`,
        "critical",
      );
    }

    const isOwnOutput = filePath.endsWith(".enc") || filePath.endsWith(".meta.json");
    if (changed && previous && !isOwnOutput && stat.size <= 2_000_000) {
      const sample = await fs.readFile(filePath);
      const entropy = shannonEntropy(sample.subarray(0, 4096));
      if (entropy >= ENTROPY_HIGH_THRESHOLD) {
        addAlert(
          "HIGH_ENTROPY_WRITE",
          filePath,
          `Sampled entropy ${entropy.toFixed(2)} bits/byte (threshold ${ENTROPY_HIGH_THRESHOLD}) — content looks encrypted/compressed, not plaintext. This file was NOT touched by LabyrinthV8.`,
          "warning",
        );
      }
    }

    if (!changed || stat.size > 2_000_000 || isOwnOutput) continue;
    try {
      const contents = await fs.readFile(filePath, "utf8");
      const matchedPatterns = Object.entries(patterns)
        .filter(([, pattern]) => pattern.test(contents))
        .map(([name]) => name);
      const matchedKeywords = keywords.filter((_keyword, index) =>
        keywordPatterns[index].test(contents),
      );
      if (matchedPatterns.length || matchedKeywords.length) {
        const reason = [
          matchedPatterns.length ? `Matched ${matchedPatterns.join(", ")}` : "",
          matchedKeywords.length
            ? `keywords: ${matchedKeywords.join(", ")}`
            : "",
        ]
          .filter(Boolean)
          .join("; ");
        if (!state.requests.some((item) => item.path === filePath && item.status === "pending")) {
          const request: ProtectionRequest = {
            id: id("req"),
            path: filePath,
            reason,
            status: "pending",
            createdAt: now(),
            decidedAt: null,
            decidedBy: null,
            encryptedTo: null,
          };
          state.requests.unshift(request);
          addAudit(
            "SCAN_HIT",
            filePath,
            "labyrinthv8-scanner",
            "Sensitive content detected; human review required.",
          );
        }
      }
    } catch {
      // Binary or unreadable files remain observable through extension and change alerts.
    }
  }

  state.snapshot = nextSnapshot;
  state.lastScan = now();
  addAudit(
    "SCAN",
    watchDir,
    "labyrinthv8-scanner",
    `Scanned ${files.length} file${files.length === 1 ? "" : "s"}.`,
  );
  await save();
}

export async function startSecurityEngine() {
  if (started) return;
  started = true;
  await load();
  await scan();
  setInterval(() => {
    void scan().catch(() => undefined);
  }, scanIntervalMs);
}

export function getWatchDir() {
  return watchDir;
}

export function getState() {
  return state;
}

export function verifyAuditChain() {
  for (let index = 0; index < state.auditEvents.length; index += 1) {
    const event = state.auditEvents[index];
    const previous = state.auditEvents[index + 1]?.hash ?? "GENESIS";
    const expected = createHash("sha256")
      .update(
        `${previous}|${event.timestamp}|${event.action}|${event.target}|${event.actor}|${event.detail}`,
      )
      .digest("hex");
    if (expected !== event.hash) return false;
  }
  return true;
}

export async function decideRequest(
  requestId: string,
  approve: boolean,
  decidedBy: string,
) {
  const request = state.requests.find((item) => item.id === requestId);
  if (!request || request.status !== "pending") return null;
  request.status = approve ? "approved" : "denied";
  request.decidedAt = now();
  request.decidedBy = decidedBy;

  if (approve) {
    const encrypted = await kms.encryptFile(request.path);
    request.encryptedTo = encrypted.outputPath;
    addAudit(
      "ENCRYPT",
      request.path,
      decidedBy,
      `Explicitly approved protection request ${request.id}; encrypted with master key ${encrypted.keyId}.`,
    );
  } else {
    request.encryptedTo = null;
    addAudit(
      "DENY_REQUEST",
      request.path,
      decidedBy,
      `Explicitly denied protection request ${request.id}; file left untouched.`,
    );
  }

  await save();
  return request;
}

/** Rotates the master key. Old ciphertext keeps decrypting fine — only new encryptFile() calls use the new version. */
export async function rotateMasterKey(actor: string) {
  const newKeyId = await kms.rotateMasterKey();
  addAudit("ROTATE_MASTER_KEY", "master", actor, `Master key rotated to ${newKeyId}.`);
  await save();
  return newKeyId;
}

/** Decrypts a previously protected file back to `decrypted_<name>` alongside it. */
export async function decryptRequestFile(requestId: string, actor: string) {
  const request = state.requests.find((item) => item.id === requestId);
  if (!request || !request.encryptedTo) return null;
  const outPath = await kms.decryptFile(request.encryptedTo);
  addAudit("DECRYPT", request.encryptedTo, actor, `Decrypted for review; output ${outPath}.`);
  await save();
  return outPath;
}