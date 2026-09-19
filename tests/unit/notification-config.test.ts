import { createECDH } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectNotificationConfig, inspectSenderDomain, senderDomain } from "@/src/lib/alerts/notification-config";

function validEnvironment() {
  const curve = createECDH("prime256v1");
  curve.generateKeys();
  const scalar = curve.getPrivateKey();
  return { RESEND_API_KEY: "re_synthetic_key", EMAIL_FROM: "HMS <alerts@hms-health.com>",
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: curve.getPublicKey().toString("base64url"),
    VAPID_PRIVATE_KEY: Buffer.concat([Buffer.alloc(32 - scalar.length), scalar]).toString("base64url"), VAPID_SUBJECT: "mailto:alerts@hms-health.com" };
}
const domainResponse = (status = "verified", sending = "enabled") => ({ object: "list", has_more: false,
  data: [{ id: "synthetic-domain", name: "hms-health.com", status, capabilities: { sending } }] });

describe("notification configuration checks", () => {
  it("cryptographically matches a generated public/private key pair without emitting any values", () => {
    const env = validEnvironment();
    const checks = inspectNotificationConfig(env);
    expect(checks.every(check => check.status === "pass")).toBe(true);
    const report = JSON.stringify(checks);
    for (const value of Object.values(env)) expect(report).not.toContain(value);
  });
  it("rejects valid-looking keys taken from different pairs", () => {
    const env = { ...validEnvironment(), VAPID_PRIVATE_KEY: validEnvironment().VAPID_PRIVATE_KEY };
    expect(inspectNotificationConfig(env).find(check => check.check === "vapid_key_pair")?.status).toBe("fail");
  });
  it.each(["", Buffer.alloc(32).toString("base64url"), Buffer.alloc(32, 255).toString("base64url"), "private-key-secret", "a".repeat(44)])("rejects malformed or out-of-range private keys without exposing them", privateKey => {
    const checks = inspectNotificationConfig({ ...validEnvironment(), VAPID_PRIVATE_KEY: privateKey });
    expect(checks.find(check => check.check === "vapid_key_pair")?.status).toBe("fail");
    if (privateKey) expect(JSON.stringify(checks)).not.toContain(privateKey);
  });
  it("rejects compressed and padded public key representations", () => {
    const env = validEnvironment();
    for (const publicKey of [env.NEXT_PUBLIC_VAPID_PUBLIC_KEY + "=", Buffer.alloc(33, 2).toString("base64url")]) {
      expect(inspectNotificationConfig({ ...env, NEXT_PUBLIC_VAPID_PUBLIC_KEY: publicKey }).find(check => check.check === "vapid_key_pair")?.status).toBe("fail");
    }
  });
  it.each(["mailto:alerts@your-domain.example", "https://localhost", "http://hms-health.com", "mailto:", "https://user:secret@hms-health.com", " mailto:alerts@hms-health.com"])("rejects unusable VAPID contacts: %s", subject => {
    expect(inspectNotificationConfig({ ...validEnvironment(), VAPID_SUBJECT: subject }).find(check => check.check === "vapid_subject")?.status).toBe("fail");
  });
  it("reports all missing fields as failures instead of allowing stubbed transports to count as delivery", () => {
    expect(inspectNotificationConfig({}).every(check => check.status === "fail")).toBe(true);
  });
  it.each(["onboarding@resend.dev", "alerts@your-domain.example", "HMS <alerts@hms-health.com>\r\nBcc:secret@hms-health.com", "HMS <alerts@hms-health.com", "a..b@hms-health.com", "a@-hms-health.com"])("rejects unsafe or development senders", sender => {
    expect(inspectNotificationConfig({ ...validEnvironment(), EMAIL_FROM: sender }).find(check => check.check === "email_sender")?.status).toBe("fail");
  });
  it("normalises the sender domain without changing the environment", () => {
    expect(senderDomain("HMS <alerts@HMS-HEALTH.com>")).toBe("hms-health.com");
  });
});

describe("read-only Resend domain evidence", () => {
  it("requires the exact sender domain to be verified and enabled", () => {
    expect(inspectSenderDomain(domainResponse(), "hms-health.com").result.status).toBe("pass");
    expect(inspectSenderDomain(domainResponse("pending"), "hms-health.com").result.status).toBe("fail");
    expect(inspectSenderDomain(domainResponse("verified", "disabled"), "hms-health.com").result.status).toBe("fail");
    expect(inspectSenderDomain(domainResponse(), "lookalike-hms-health.com").result.status).toBe("fail");
    expect(inspectSenderDomain(domainResponse(), "mail.hms-health.com").result.status).toBe("fail");
  });
  it("does not infer sending support from absent provider capabilities", () => {
    const body = { object: "list", has_more: false, data: [{ name: "hms-health.com", status: "verified" }] };
    expect(inspectSenderDomain(body, "hms-health.com").result.status).toBe("unverified");
  });
  it("does not mistake an incomplete domain list for a missing sender", () => {
    const body = { object: "list", has_more: true, data: [{ id: "cursor-1", name: "other-domain.com" }] };
    expect(inspectSenderDomain(body, "hms-health.com")).toMatchObject({ nextCursor: "cursor-1", result: { status: "unverified" } });
    expect(inspectSenderDomain({ ...body, has_more: false }, "hms-health.com").result.status).toBe("fail");
  });
  it.each([null, {}, { error: "secret provider error" }, { object: "list", data: [] }])("does not accept unknown provider response shapes or disclose their contents", body => {
    const result = inspectSenderDomain(body, "hms-health.com");
    expect(result.result.status).toBe("unverified");
    expect(JSON.stringify(result)).not.toContain("secret provider error");
  });
});

describe("notification verification command", () => {
  function runCommand(mock: string, options: { provider?: boolean; envFile?: string } = {}) {
    const code = `import assert from "node:assert/strict";
      process.argv = [process.execPath, "scripts/verify-notification-config.ts"${options.provider ? ', "--provider"' : ""}];
      ${mock}
      await import("./scripts/verify-notification-config.ts");`;
    return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code], {
      cwd: process.cwd(), encoding: "utf8", timeout: 15_000,
      env: { NODE_ENV: "test", PATH: process.env.PATH, ...validEnvironment(), ...(options.envFile ? { HMS_NOTIFICATION_ENV_FILE: options.envFile } : {}) },
    });
  }

  it("uses authenticated GET requests only, follows pagination, and never sends a notification", () => {
    const run = runCommand(`let calls = 0;
      globalThis.fetch = async (url, init) => {
        assert.equal(url.origin, "https://api.resend.com");
        assert.equal(url.pathname, "/domains");
        assert.equal(init.method, "GET");
        assert.equal(init.redirect, "error");
        assert.equal(init.body, undefined);
        assert.equal(init.headers.Authorization, "Bearer re_synthetic_key");
        assert.equal(url.searchParams.get("after"), calls === 0 ? null : "page-1");
        calls++;
        return new Response(JSON.stringify(calls === 1
          ? { object: "list", has_more: true, data: [{ id: "page-1", name: "other-domain.com" }] }
          : { object: "list", has_more: false, data: [{ id: "page-2", name: "hms-health.com", status: "verified", capabilities: { sending: "enabled" } }] }));
      };
      process.once("beforeExit", () => assert.equal(calls, 2));`, { provider: true });
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toMatchObject({ localConfigurationValid: true, senderDomainVerified: true, deliveryVerified: false, notificationsSent: 0 });
    expect(run.stdout).not.toContain("re_synthetic_key");
  });

  it("keeps provider permission failure unverified and redacts the provider error body", () => {
    const run = runCommand('globalThis.fetch = async () => new Response("secret provider response", { status: 403 });', { provider: true });
    expect(run.status).toBe(1);
    const report = JSON.parse(run.stdout);
    expect(report).toMatchObject({ senderDomainVerified: false, deliveryVerified: false, notificationsSent: 0 });
    expect(report.checks).toContainEqual(expect.objectContaining({ check: "sender_domain", status: "unverified" }));
    expect(run.stdout + run.stderr).not.toContain("secret provider response");
  });

  it("does not fill missing file values from inherited credentials or implicitly read .env.local", () => {
    const directory = mkdtempSync(join(tmpdir(), "hms-notification-config-"));
    const file = join(directory, "explicit.env");
    try {
      writeFileSync(file, "EMAIL_FROM=alerts@hms-health.com\n", { mode: 0o600 });
      const run = runCommand('globalThis.fetch = async () => { throw new Error("Unexpected network access"); };', { envFile: file });
      expect(run.status).toBe(1);
      const report = JSON.parse(run.stdout);
      expect(report).toMatchObject({ source: "explicit_env_file", localConfigurationValid: false, notificationsSent: 0 });
      expect(report.checks).toContainEqual(expect.objectContaining({ check: "resend_key", status: "fail" }));
      expect(report.checks).toContainEqual(expect.objectContaining({ check: "email_sender", status: "pass" }));
      expect(report.checks).toContainEqual(expect.objectContaining({ check: "vapid_key_pair", status: "fail" }));
    } finally { rmSync(directory, { recursive: true }); }
  });
});
