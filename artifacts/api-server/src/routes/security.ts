import { Router, type IRouter } from "express";
import {
  ApproveProtectionRequestBody,
  ApproveProtectionRequestParams,
  DenyProtectionRequestBody,
  DenyProtectionRequestParams,
} from "@workspace/api-zod";
import {
  decideRequest,
  decryptRequestFile,
  getState,
  getWatchDir,
  rotateMasterKey,
  startSecurityEngine,
  verifyAuditChain,
} from "../lib/security-engine";

const router: IRouter = Router();
void startSecurityEngine();

router.get("/security/summary", (_req, res) => {
  const state = getState();
  res.json({
    pending: state.requests.filter((item) => item.status === "pending").length,
    criticalAlerts: state.alerts.filter((item) => item.severity === "critical").length,
    monitoredFiles: Object.keys(state.snapshot).length,
    chainIntact: verifyAuditChain(),
    lastScan: state.lastScan,
    scanInterval: `${process.env.LABYRINTH_SCAN_INTERVAL_SECONDS ?? 15} sec`,
    watchDir: getWatchDir(),
  });
});

router.get("/security/alerts", (_req, res) => res.json(getState().alerts));

router.get("/security/requests/pending", (_req, res) =>
  res.json(getState().requests.filter((item) => item.status === "pending")),
);

router.get("/security/requests/history", (_req, res) =>
  res.json(getState().requests.filter((item) => item.status !== "pending")),
);

router.post("/security/requests/:id/approve", async (req, res) => {
  const params = ApproveProtectionRequestParams.safeParse(req.params);
  const body = ApproveProtectionRequestBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "A named approver is required." });
    return;
  }
  const request = await decideRequest(params.data.id, true, body.data.approver);
  if (!request) {
    res.status(404).json({ error: "Request not found or already decided." });
    return;
  }
  res.json({
    status: "approved",
    message: "Protection approved and recorded in the audit trail.",
    encryptedTo: request.encryptedTo,
  });
});

router.post("/security/requests/:id/deny", async (req, res) => {
  const params = DenyProtectionRequestParams.safeParse(req.params);
  const body = DenyProtectionRequestBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "A named decision-maker is required." });
    return;
  }
  const request = await decideRequest(params.data.id, false, body.data.approver);
  if (!request) {
    res.status(404).json({ error: "Request not found or already decided." });
    return;
  }
  res.json({
    status: "denied",
    message: "Request denied. The file was left untouched.",
    encryptedTo: null,
  });
});

router.post("/security/rotate-key", async (req, res) => {
  const actor = typeof req.body?.actor === "string" ? req.body.actor : null;
  if (!actor) {
    res.status(400).json({ error: "A named actor is required to rotate the master key." });
    return;
  }
  const keyId = await rotateMasterKey(actor);
  res.json({ status: "rotated", keyId });
});

router.post("/security/requests/:id/decrypt", async (req, res) => {
  const actor = typeof req.body?.actor === "string" ? req.body.actor : null;
  const { id } = req.params;
  if (!actor) {
    res.status(400).json({ error: "A named actor is required to decrypt." });
    return;
  }
  const outPath = await decryptRequestFile(id, actor);
  if (!outPath) {
    res.status(404).json({ error: "Request not found or not encrypted." });
    return;
  }
  res.json({ status: "decrypted", outputPath: outPath });
});

router.get("/security/audit", (_req, res) => {
  const state = getState();
  res.json({
    chainIntact: verifyAuditChain(),
    events: state.auditEvents.slice(0, 100).map(({ hash: _hash, ...event }) => event),
  });
});

export default router;