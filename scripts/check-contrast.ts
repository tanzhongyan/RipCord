import { checkContrastPairs } from "../src/shared/config/tokens";

const results = checkContrastPairs();
let failed = 0;
for (const r of results) {
  const mark = r.pass ? "pass" : "FAIL";
  if (!r.pass) failed += 1;
  console.log(
    `${mark} ${r.theme} ${r.foreground} on ${r.background}: ${r.ratio.toFixed(2)} (min ${r.minimum})`,
  );
}
if (failed > 0) {
  console.error(`contrast: ${failed} pair(s) below WCAG minimum; fix src/shared/config/tokens.ts`);
  process.exit(1);
}
console.log(`contrast: ${results.length} pairs pass WCAG in both themes`);
