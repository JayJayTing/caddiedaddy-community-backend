import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { prisma } from '../lib/prisma'
import { authMiddleware } from '../middleware/auth'

const notifications = new Hono()

// ── GET /notifications ──────────────────────────────────────────────────────────
// The current user's notifications (newest first) + the unread count for the badge.

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(40),
})

notifications.get('/', authMiddleware, zValidator('query', listQuery), async (c) => {
  const { sub: userId } = c.get('user')
  const { limit } = c.req.valid('query')

  const [data, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ])

  return c.json({ data, unreadCount })
})

// ── POST /notifications/read-all ────────────────────────────────────────────────

notifications.post('/read-all', authMiddleware, async (c) => {
  const { sub: userId } = c.get('user')
  await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  })
  return c.json({ ok: true })
})

// ── PATCH /notifications/:id/read ───────────────────────────────────────────────

notifications.patch('/:id/read', authMiddleware, async (c) => {
  const { sub: userId } = c.get('user')
  const id = c.req.param('id')
  // scoped to the owner so you can't mark someone else's notification read
  await prisma.notification.updateMany({
    where: { id, userId },
    data: { readAt: new Date() },
  })
  return c.json({ ok: true })
})

// ── GET /notifications/prefs ────────────────────────────────────────────────────

const defaultPrefs = {
  roundsNearby: true,
  communityActivity: true,
  roundReminders: true,
  newMessages: true,
}

notifications.get('/prefs', authMiddleware, async (c) => {
  const { sub: userId } = c.get('user')
  const pref = await prisma.userNotificationPref.findUnique({ where: { userId } })
  return c.json({ data: pref ?? { userId, ...defaultPrefs } })
})

// ── PUT /notifications/prefs ────────────────────────────────────────────────────

const prefsSchema = z.object({
  roundsNearby: z.boolean().optional(),
  communityActivity: z.boolean().optional(),
  roundReminders: z.boolean().optional(),
  newMessages: z.boolean().optional(),
})

notifications.put('/prefs', authMiddleware, zValidator('json', prefsSchema), async (c) => {
  const { sub: userId } = c.get('user')
  const body = c.req.valid('json')
  const data = await prisma.userNotificationPref.upsert({
    where: { userId },
    create: { userId, ...defaultPrefs, ...body },
    update: body,
  })
  return c.json({ data })
})

export default notifications
