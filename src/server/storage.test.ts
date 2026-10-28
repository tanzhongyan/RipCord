import { CreateBucketCommand, DeleteObjectsCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";

import {
  ALLOWED_UPLOAD_TYPES,
  createStorage,
  documentKey,
  MAX_UPLOAD_BYTES,
  StorageError,
} from "~/server/storage";

class FakeSender {
  readonly commands: unknown[] = [];
  constructor(private readonly behavior: (command: unknown) => unknown = () => ({})) {}

  async send(command: unknown): Promise<unknown> {
    this.commands.push(command);
    const out = this.behavior(command);
    if (out instanceof Error) throw out;
    return out;
  }
}

describe("document storage", () => {
  it("accepts only PDF, PNG and JPEG under 10 MB", async () => {
    expect(ALLOWED_UPLOAD_TYPES).toEqual(["application/pdf", "image/png", "image/jpeg"]);
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
    const storage = createStorage(new FakeSender());
    await expect(storage.put("k", new Uint8Array([1]), "text/plain")).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(
      storage.put("k", new Uint8Array(MAX_UPLOAD_BYTES + 1), "application/pdf"),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("uploads with server-side encryption and returns the sha256", async () => {
    const sender = new FakeSender();
    const storage = createStorage(sender);
    const bytes = new Uint8Array([1, 2, 3]);
    const { sha256 } = await storage.put("cases/c/d.pdf", bytes, "application/pdf");
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sender.commands).toHaveLength(1);
    const [command] = sender.commands as [PutObjectCommand];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({
      Key: "cases/c/d.pdf",
      ContentType: "application/pdf",
      ContentLength: 3,
      ServerSideEncryption: "AES256",
    });
  });

  it("creates the bucket once when it is missing, then retries", async () => {
    let calls = 0;
    const sender = new FakeSender((command) => {
      calls++;
      if (command instanceof PutObjectCommand && calls === 1) {
        return Object.assign(new Error("NoSuchBucket"), { name: "NoSuchBucket" });
      }
      return {};
    });
    const storage = createStorage(sender);
    await storage.put("k", new Uint8Array([1]), "application/pdf");
    expect(sender.commands[0]).toBeInstanceOf(PutObjectCommand);
    expect(sender.commands[1]).toBeInstanceOf(CreateBucketCommand);
    expect(sender.commands[2]).toBeInstanceOf(PutObjectCommand);
  });

  it("maps storage failures to INTERNAL_ERROR", async () => {
    const failing = new FakeSender(() => new Error("boom"));
    const storage = createStorage(failing);
    await expect(storage.put("k", new Uint8Array([1]), "application/pdf")).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
    await expect(storage.del(["k"])).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("deletes in one batch and skips empty deletes", async () => {
    const sender = new FakeSender();
    const storage = createStorage(sender);
    await storage.del([]);
    expect(sender.commands).toHaveLength(0);
    await storage.del(["a", "b"]);
    expect(sender.commands).toHaveLength(1);
    const [command] = sender.commands as [DeleteObjectsCommand];
    expect(command).toBeInstanceOf(DeleteObjectsCommand);
    expect(command.input.Delete?.Objects).toEqual([{ Key: "a" }, { Key: "b" }]);
  });

  it("builds keys as cases/<caseId>/<docId>.<ext>", () => {
    expect(documentKey("case-1", "doc-2", "pdf")).toBe("cases/case-1/doc-2.pdf");
  });

  it("carries a domain code on StorageError", () => {
    expect(new StorageError("VALIDATION", "bad").code).toBe("VALIDATION");
  });
});
