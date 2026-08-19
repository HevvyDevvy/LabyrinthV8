import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
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
      const matchedKeywords = keywords.filter((keyword) =>
        contents.toLowerCase().includes(keyword),
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