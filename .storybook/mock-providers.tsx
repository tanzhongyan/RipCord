import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TRPCLink } from "@trpc/client";
import { TRPCClientError } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import type { AppRouter } from "~/server/api/root";
import { createQueryClient } from "~/trpc/query-client";
import { api } from "~/trpc/react";

/**
 * Shared mock providers for stories: theme and a tRPC client that serves canned
 * data. Better Auth needs no provider (authClient is a plain client), so a story
 * that reads the session passes its own data through `mocks`. Nothing here
 * touches the network.
 */
export type MockMap = Record<string, unknown | Error>;

const mockLink = (mocks: MockMap): TRPCLink<AppRouter> => {
  return () => {
    return ({ op }) => {
      return observable((emit) => {
        const canned = mocks[op.path];
        if (canned instanceof Error) {
          emit.error(new TRPCClientError(canned.message));
        } else if (canned === undefined) {
          emit.error(new TRPCClientError(`No mock for ${op.path}`));
        } else {
          emit.next({ result: { data: canned } });
          emit.complete();
        }
      });
    };
  };
};

export function MockAppProviders({
  children,
  mocks = {},
  theme = "light",
}: {
  children: React.ReactNode;
  mocks?: MockMap;
  theme?: string;
}) {
  const [queryClient] = useState<QueryClient>(() => {
    const client = createQueryClient();
    client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });
    return client;
  });
  const [trpcClient] = useState(() => api.createClient({ links: [mockLink(mocks)] }));

  return (
    <ThemeProvider attribute="class" forcedTheme={theme} disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <api.Provider client={trpcClient} queryClient={queryClient}>
          {children}
        </api.Provider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
