import { createHash } from "node:crypto";
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { env } from "~/shared/config/env";

/** Maximum upload size: 10 MB (spec 0002 Budgets). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** The only accepted upload content types (spec 0002 Budgets). */
export const ALLOWED_UPLOAD_TYPES: readonly string[] = [
  "application/pdf",
  "image/png",
  "image/jpeg",
];

export class StorageError extends Error {
  readonly code: "VALIDATION" | "INTERNAL_ERROR";

  constructor(code: "VALIDATION" | "INTERNAL_ERROR", message: string) {
    super(`[${code}] ${message}`);
    this.name = "StorageError";
    this.code = code;
  }
}

export interface StorageClient {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<{ sha256: string }>;
  get(key: string): Promise<Uint8Array>;
  presignUpload(key: string, contentType: string): Promise<{ url: string }>;
  del(keys: string[]): Promise<void>;
}

/** Upload URLs stay valid for 15 minutes. */
export const UPLOAD_URL_TTL_SECONDS = 900;

/** Object key for a case document: `cases/<caseId>/<docId>.<ext>`. */
export function documentKey(caseId: string, docId: string, extension: string): string {
  return `cases/${caseId}/${docId}.${extension}`;
}

function validateUpload(bytes: Uint8Array, contentType: string): void {
  if (!ALLOWED_UPLOAD_TYPES.includes(contentType)) {
    throw new StorageError("VALIDATION", `Upload must be PDF, PNG or JPEG, got ${contentType}`);
  }
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new StorageError("VALIDATION", `Upload exceeds ${MAX_UPLOAD_BYTES} bytes`);
  }
}

function isNoSuchBucket(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name: string }).name === "NoSuchBucket"
  );
}

type S3Sender = Pick<S3Client, "send">;

type PresignFn = (key: string, contentType: string) => Promise<string>;

class S3Storage implements StorageClient {
  constructor(
    private readonly s3: S3Sender,
    private readonly bucket: string,
    private readonly presign?: PresignFn,
  ) {}

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<{ sha256: string }> {
    validateUpload(bytes, contentType);
    const put = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: bytes,
      ContentType: contentType,
      ContentLength: bytes.length,
      ServerSideEncryption: "AES256",
    });
    try {
      await this.s3.send(put);
    } catch (error) {
      if (!isNoSuchBucket(error)) {
        throw new StorageError("INTERNAL_ERROR", "Upload failed");
      }
      // First upload to a fresh MinIO: create the bucket once, then retry.
      await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }));
      try {
        await this.s3.send(put);
      } catch {
        throw new StorageError("INTERNAL_ERROR", "Upload failed");
      }
    }
    return { sha256: createHash("sha256").update(bytes).digest("hex") };
  }

  async get(key: string): Promise<Uint8Array> {
    let out: { Body?: unknown };
    try {
      out = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch {
      throw new StorageError("INTERNAL_ERROR", "Download failed");
    }
    const body = out.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
    if (!body || typeof body.transformToByteArray !== "function") {
      throw new StorageError("INTERNAL_ERROR", "Download failed");
    }
    try {
      return await body.transformToByteArray();
    } catch {
      throw new StorageError("INTERNAL_ERROR", "Download failed");
    }
  }

  async presignUpload(key: string, contentType: string): Promise<{ url: string }> {
    if (!ALLOWED_UPLOAD_TYPES.includes(contentType)) {
      throw new StorageError("VALIDATION", `Upload must be PDF, PNG or JPEG, got ${contentType}`);
    }
    if (!this.presign) {
      throw new StorageError("INTERNAL_ERROR", "Upload signing is not configured");
    }
    try {
      return { url: await this.presign(key, contentType) };
    } catch {
      throw new StorageError("INTERNAL_ERROR", "Upload signing failed");
    }
  }

  async del(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      try {
        await this.s3.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })) },
          }),
        );
      } catch {
        throw new StorageError("INTERNAL_ERROR", "Delete failed");
      }
    }
  }
}

const globalForStorage = globalThis as unknown as { storage: StorageClient | undefined };

/**
 * S3-backed document storage (MinIO in development, any S3 in production).
 * Tests pass a fake `sender` to record calls without a server.
 */
export function createStorage(sender?: S3Sender, presign?: PresignFn): StorageClient {
  if (sender) return new S3Storage(sender, env.S3_BUCKET, presign);
  if (!globalForStorage.storage) {
    const s3 = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: "us-east-1",
      forcePathStyle: true,
      credentials:
        env.S3_ACCESS_KEY && env.S3_SECRET_KEY
          ? { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY }
          : undefined,
    });
    const sign: PresignFn = (key, contentType) =>
      getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, ContentType: contentType }),
        { expiresIn: UPLOAD_URL_TTL_SECONDS },
      );
    globalForStorage.storage = new S3Storage(s3, env.S3_BUCKET, sign);
  }
  return globalForStorage.storage;
}
