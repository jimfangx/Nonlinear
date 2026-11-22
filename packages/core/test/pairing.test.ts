import { describe, expect, it } from "vitest";
import { generateSyncKey, toRecoveryKey, fromRecoveryKey, makeKeyCheck, verifyKeyCheck, newPairingKeypair, wrapForDevice, unwrapFromApprover, verificationCode, importSyncKey, syncKeySalt } from "../src/sync/pairing";
import { encryptOp, decryptOp, type Op } from "../src/sync/oplog";

describe("one-click sync keys", () => {
  it("recovery key round-trips for keys containing '-' and '_' (regression)", () => {
    for (let i = 0; i < 300; i++) {
      const k = generateSyncKey();
      expect(fromRecoveryKey(toRecoveryKey(k))).toBe(k);
      expect(fromRecoveryKey(toRecoveryKey(k).toLowerCase())).toBe(k);
    }
    const dashy = "-".repeat(4) + generateSyncKey().slice(4);
    expect(fromRecoveryKey(toRecoveryKey(dashy))).toBe(dashy);
  });
  it("recovery key round-trips", () => {
    const k = generateSyncKey();
    const rk = toRecoveryKey(k);
    expect(rk).toMatch(/^NL1-(\w|-)+$/);
    expect(fromRecoveryKey(rk)).toBe(k);
    expect(fromRecoveryKey("NL1-nope")).toBeNull();
  });
  it("key check verifies only the right key", async () => {
    const k = generateSyncKey();
    const c = await makeKeyCheck(k);
    expect(await verifyKeyCheck(k, c)).toBe(true);
    expect(await verifyKeyCheck(generateSyncKey(), c)).toBe(false);
  });
  it("pairs a new device via ECDH without the server seeing the key", async () => {
    const k = generateSyncKey();
    const newDev = await newPairingKeypair();
    const { wrapped, approverPub } = await wrapForDevice(k, newDev.publicKey);
    expect(wrapped).not.toContain(k);
    expect(await unwrapFromApprover(newDev, wrapped, approverPub)).toBe(k);
    const attacker = await newPairingKeypair();
    await expect(unwrapFromApprover(attacker, wrapped, approverPub)).rejects.toBeTruthy();
    expect(await verificationCode(newDev.publicKey)).toMatch(/^\d{3} \d{3}$/);
  });
  it("sync key encrypts ops", async () => {
    const k = generateSyncKey();
    const op: Op = { opId: "1", userId: "u", deviceId: "d", entityKind: "card", entityId: "c", baseRevision: 0, timestamp: 1, action: "set", payload: { a: 1 }, schemaVersion: 1 };
    const e = await encryptOp(op, await importSyncKey(k), await syncKeySalt(k));
    expect(await decryptOp(e, await importSyncKey(k))).toEqual(op);
  });
});
