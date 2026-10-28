import { z } from "zod";

const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(8000),
});

export type ChatMessageInput = z.infer<typeof chatMessageSchema>;

const chatApprovalSchema = z.object({
  name: z.string().min(1).max(80),
  args: z.record(z.string(), z.unknown()).default({}),
});

export type ChatApprovalInput = z.infer<typeof chatApprovalSchema>;

export const chatRequestSchema = z.object({
  messages: z.array(chatMessageSchema).min(1).max(40),
  caseId: z.uuid().optional(),
  approvals: z.array(chatApprovalSchema).max(12).optional(),
});

export type ChatRequestInput = z.infer<typeof chatRequestSchema>;

/** One server-sent event on `POST /api/chat`. */
export const chatEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("token"), text: z.string() }),
  z.object({
    type: z.literal("tool_call"),
    callId: z.string(),
    name: z.string(),
    args: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("tool_result"),
    callId: z.string(),
    name: z.string(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    code: z.string().optional(),
    message: z.string().optional(),
  }),
  z.object({
    type: z.literal("confirm_request"),
    callId: z.string(),
    name: z.string(),
    args: z.record(z.string(), z.unknown()),
    summary: z.string(),
  }),
  z.object({ type: z.literal("done") }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);

export type ChatEvent = z.infer<typeof chatEventSchema>;
