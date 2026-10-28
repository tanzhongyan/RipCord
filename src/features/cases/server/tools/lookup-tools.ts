import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { listHolders } from "~/features/identity";
import {
  getProvider,
  getProviderSchema,
  liveSearchDeps,
  searchProviders,
  searchProvidersSchema,
} from "~/features/providers";
import { ToolError } from "../errors";
import type { ToolDef } from "./registry";

function toToolError(error: unknown): ToolError {
  if (error instanceof ToolError) return error;
  if (error instanceof TRPCError) {
    if (error.code === "NOT_FOUND") return new ToolError("NOT_FOUND", "Provider not found");
    if (error.code === "TOO_MANY_REQUESTS") {
      return new ToolError("RATE_LIMITED", "Provider search allows 60 requests per minute");
    }
    if (error.code === "BAD_REQUEST") return new ToolError("VALIDATION", error.message);
  }
  throw error;
}

/**
 * Tools without a case: provider knowledge and holder hints. Provider
 * search rate-limits by the caller's user id, since tools carry no IP.
 */
export function lookupToolDefs(): ToolDef[] {
  return [
    {
      name: "search-providers",
      budget: "read",
      confirm: false,
      statuses: null,
      input: searchProvidersSchema,
      handler: async (input, ctx) => {
        try {
          return await searchProviders(
            input as { query: string; country?: string },
            { ip: `user:${ctx.userId}` },
            liveSearchDeps(),
          );
        } catch (error) {
          throw toToolError(error);
        }
      },
    },
    {
      name: "get-provider",
      budget: "read",
      confirm: false,
      statuses: null,
      input: getProviderSchema,
      handler: async (input) => {
        try {
          return await getProvider(input as { id: string }, liveSearchDeps());
        } catch (error) {
          throw toToolError(error);
        }
      },
    },
    {
      name: "list-holders",
      budget: "read",
      confirm: false,
      statuses: null,
      input: z.object({}),
      handler: async (_input, ctx) => {
        return listHolders({ userId: ctx.userId, orgIds: ctx.orgIds });
      },
    },
  ];
}
