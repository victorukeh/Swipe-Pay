import { existsSync } from 'node:fs';

import { defineConfig } from 'prisma/config';

// A prisma.config.ts disables Prisma's own .env loading, so do it here. Without
// this, `yarn prisma:migrate` would need DATABASE_URL exported by hand.
for (const file of ['.env.local', '.env']) {
  if (existsSync(file)) {
    process.loadEnvFile(file);
  }
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'ts-node -r tsconfig-paths/register prisma/seed.ts',
  },
});
