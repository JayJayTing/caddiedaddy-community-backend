import { Hono } from 'hono'
import { prisma } from '../lib/prisma'

const announcements = new Hono()

// ── GET /announcements ─────────────────────────────────────────────────────────

announcements.get('/', async (c) => {
  const now = new Date()

  const data = await prisma.announcement.findMany({
    where: {
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: now } },
      ],
    },
    orderBy: { publishedAt: 'desc' },
    take: 10,
  })

  return c.json({ data })
})

export default announcements
