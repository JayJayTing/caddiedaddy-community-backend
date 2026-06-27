import 'dotenv/config'
import { defineConfig } from 'prisma/config'

// Prisma 7 no longer auto-loads .env when a config file is present, so we load it
// above. Migration / introspection commands (db push, migrate) need datasource.url —
// use the direct (non-pooled) connection for these.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '',
  },
})
