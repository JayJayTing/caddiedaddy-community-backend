import { defineConfig } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasourceUrl: process.env['DIRECT_URL'] ?? process.env['DATABASE_URL'] ?? '',
})
