import { runVerificationsCron } from "~/features/cases/server/verifications";

const counts = await runVerificationsCron();
console.log(JSON.stringify({ ok: true, ...counts }));
