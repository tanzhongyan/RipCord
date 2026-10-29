import type { actorType } from "~/server/db/schema";

type ActorType = (typeof actorType.enumValues)[number];

/** Who did it, in the voice of DESIGN.md: RipCord is "we", the user is "you". */
function subject(actor: string, holderAlias: string | null): string {
  const subjects: Record<ActorType, string> = {
    USER: "You",
    HOLDER: holderAlias ?? "The account holder",
    AGENT: "Your connected agent",
    SYSTEM: "We",
    ADMIN: "We",
  };
  return (subjects as Record<string, string>)[actor] ?? "Someone";
}

/** Audit `action` to a plain sentence, given who did it. Sits beside the status labels. */
const SENTENCES: Record<string, (who: string) => string> = {
  CASE_CREATED: (who) => `${who} opened this case`,
  CASE_TRANSITION: (who) => `${who} moved the case to a new stage`,
  TOOL_CALL: (who) => `${who} worked on this case in chat`,
  STEP_APPROVED: (who) => `${who} approved a step`,
  MANDATE_SIGNED: (who) => `${who} signed the mandate`,
  MANDATE_REVOKED: (who) => `${who} withdrew the mandate`,
  MANDATE_EXPIRED: () => "The mandate expired before it was signed",
};

/** "SOME_EVENT" or "some.event" as "Some event". */
function humanise(action: string): string {
  const words = action.replace(/[._]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** One case timeline row as a sentence; unknown actions fall back to a humanised name. */
export function timelineSentence(
  row: { action: string; actorType: string },
  holderAlias: string | null = null,
): string {
  const sentence = SENTENCES[row.action];
  return sentence ? sentence(subject(row.actorType, holderAlias)) : humanise(row.action);
}
