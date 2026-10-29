"use client";

import dynamic from "next/dynamic";
import { useState } from "react";

import { Button } from "~/shared/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "~/shared/components/ui/sheet";
import { Skeleton } from "~/shared/components/ui/skeleton";

// The chat loads only when the sheet first opens, so the case page stays small.
const ChatClient = dynamic(
  () => import("~/features/chat/components/chat-client").then((m) => m.ChatClient),
  {
    ssr: false,
    loading: () => <Skeleton className="m-4 h-24" />,
  },
);

/** "Ask about this case": the chat in a side sheet, full screen below md. */
export function CaseChatSheet({ caseId }: { caseId: string }) {
  const [opened, setOpened] = useState(false);
  return (
    <Sheet onOpenChange={(open) => open && setOpened(true)}>
      <SheetTrigger render={<Button variant="outline" className="h-11 px-4" />}>
        Ask about this case
      </SheetTrigger>
      <SheetContent
        side="right"
        className="w-full max-w-none gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-none md:data-[side=right]:w-[32rem]"
      >
        <SheetHeader className="border-b">
          <SheetTitle>Ask about this case</SheetTitle>
          <SheetDescription className="sr-only">
            Chat with RipCord about this case.
          </SheetDescription>
        </SheetHeader>
        {opened ? <ChatClient caseId={caseId} /> : null}
      </SheetContent>
    </Sheet>
  );
}
