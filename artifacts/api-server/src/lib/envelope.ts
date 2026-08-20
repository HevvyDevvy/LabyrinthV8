/**
 * LabyrinthV8 :: Envelope Encryption Engine
 * -----------------------------------------
 * Real per-file envelope encryption, ported from the reference Python
 * implementation (kms/envelope.py) so the Node/Express backend that powers
 * this dashboard actually performs the protection it displays, instead of
 * only labeling a request as "approved."
 *
 * Design, unchanged from the reference implementation:
 *  - Every file gets its own randomly generated 256-bit data key.
 *  - A separate master key (local dev keystore here; swap in AWS KMS /
 *    HashiCorp Vault / Azure Key Vault for production via a real
 *    implementation of KeyBackend) wraps that data key. The master key
 *    itself is never written next to the ciphertext.
 *  - Nothing runs automatically off filesystem events. encryptFile() is
 *    only ever called from one place: the human-approved decision path in
 *    security-engine.ts.
 *  - Every wrap/unwrap/rotate is recorded by the caller into the same
 *    hash-chained audit log the rest of the app already uses.
 *
 * Algorithm: AES-256-GCM (Node's built-in `node:crypto`, no extra
 * dependency needed) instead of Fernet, since this is Node rather than
 * Python — same envelope pattern, different cipher primitive.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12; // recommended for GCM

export type KeyBackend = {
  currentKeyId(): Promise<string>;
  rotate(): Promise<string>;
  wrap(plaintextKey: Buffer, keyId: string): Promise<Buffer>;
  unwrap(wrappedKey: Buffer, keyId: string): Promise<Buffer>;
};

type Keystore = Record<string, string>; // keyId -> base64(32-byte master key)

/**
 * Local stand-in for a real KMS. Master keys are stored in a local file
 * with restrictive permissions, versioned by keyId, so rotation works the
 * same way it would against a real KMS.
 *
 * !! Replace with an AwsKmsBackend / VaultBackend before production use. !!
 */
export class LocalDevBackend implements KeyBackend {
  constructor(private readonly keystorePath: string) {}

  private async readStore(): Promise<Keystore> {
    try {
      const contents = await fs.readFile(this.keystorePath, "utf8");
      return JSON.parse(contents) as Keystore;
    } catch {
      return {};
    }
  }

  private async writeStore(store: Keystore): Promise<void> {
    await fs.mkdir(path.dirname(this.keystorePath), { recursive: true });
    await fs.writeFile(this.keystorePath, JSON.stringify(store), { mode: 0o600 });
  }

  async currentKeyId(): Promise<string> {
    const store = await this.readStore();
    const ids = Object.keys(store).sort();
    if (ids.length === 0) return this.rotate();
    return ids[ids.length - 1] as string;
  }

  async rotate(): Promise<string> {
    const store = await this.readStore();
    const keyId = `master-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    store[keyId] = randomBytes(32).toString("base64");
    await this.writeStore(store);
    return keyId;
  }

  async wrap(plaintextKey: Buffer, keyId: string): Promise<Buffer> {
    const store = await this.readStore();
    const masterB64 = store[keyId];
    if (!masterB64) throw new Error(`Unknown master key version: ${keyId}`);
    const master = Buffer.from(masterB64, "base64");
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGO, master, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintextKey), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // Pack iv | authTag | ciphertext into one buffer for storage.
    return Buffer.concat([iv, authTag, ciphertext]);
  }

  async unwrap(wrapped: Buffer, keyId: string): Promise<Buffer> {
    const store = await this.readStore();
    const masterB64 = store[keyId];
    if (!masterB64) throw new Error(`Unknown master key version: ${keyId}`);
    const master = Buffer.from(masterB64, "base64");
    const iv = wrapped.subarray(0, IV_LENGTH);
    const authTag = wrapped.subarray(IV_LENGTH, IV_LENGTH + 16);
    const ciphertext = wrapped.subarray(IV_LENGTH + 16);
    const decipher = createDecipheriv(ALGO, master, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}

export type EncryptedObject = {
  outputPath: string;
  metaPath: string;
  keyId: string;
};

type FileMeta = {
  keyId: string;
  iv: string; // base64
  authTag: string; // base64
  wrappedKey: string; // base64
  originalName: string;
};

export class EnvelopeKMS {
  constructor(private readonly backend: KeyBackend) {}

  /** Encrypts `filePath` in place-adjacent form: writes `<path>.enc` + `<path>.enc.meta.json`. */
  async encryptFile(filePath: string): Promise<EncryptedObject> {
    const plaintext = await fs.readFile(filePath);
    const dataKey = randomBytes(32);
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGO, dataKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const keyId = await this.backend.currentKeyId();
    const wrappedKey = await this.backend.wrap(dataKey, keyId);

    const outputPath = `${filePath}.enc`;
    const metaPath = `${outputPath}.meta.json`;
    await fs.writeFile(outputPath, ciphertext, { mode: 0o600 });

    const meta: FileMeta = {
      keyId,
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
      wrappedKey: wrappedKey.toString("base64"),
      originalName: path.basename(filePath),
    };
    await fs.writeFile(metaPath, JSON.stringify(meta), { mode: 0o600 });

    return { outputPath, metaPath, keyId };
  }

  /** Reverses encryptFile: reads `<encPath>` + its `.meta.json`, writes `decrypted_<originalName>` alongside it. */
  async decryptFile(encPath: string): Promise<string> {
    const metaPath = `${encPath}.meta.json`;
    const meta = JSON.parse(await fs.readFile(metaPath, "utf8")) as FileMeta;

    const wrappedKey = Buffer.from(meta.wrappedKey, "base64");
    const dataKey = await this.backend.unwrap(wrappedKey, meta.keyId);

    const ciphertext = await fs.readFile(encPath);
    const iv = Buffer.from(meta.iv, "base64");
    const authTag = Buffer.from(meta.authTag, "base64");
    const decipher = createDecipheriv(ALGO, dataKey, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    const outPath = path.join(path.dirname(encPath), `decrypted_${meta.originalName}`);
    await fs.writeFile(outPath, plaintext, { mode: 0o600 });
    return outPath;
  }

  async rotateMasterKey(): Promise<string> {
    return this.backend.rotate();
  }
}

/** Shannon entropy in bits/byte, used by the monitor to flag content that looks encrypted/compressed. */
export function shannonEntropy(data: Buffer): number {
  if (data.length === 0) return 0;
  const counts = new Map<number, number>();
  for (const byte of data) counts.set(byte, (counts.get(byte) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / data.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
