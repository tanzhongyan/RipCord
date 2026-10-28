import { seedProviders } from "../src/features/providers/server/seed";
import { valkey } from "../src/features/providers/server/valkey";
import { db } from "../src/server/db";

const counts = await seedProviders(db, valkey());
console.log(
  `Seeded ${counts.providers} providers, ${counts.demoChannels} demo channels, ${counts.demoPolicies} demo policies.`,
);
process.exit(0);
