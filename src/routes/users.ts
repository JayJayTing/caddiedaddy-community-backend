import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { authMiddleware } from '../middleware/auth'

const users = new Hono()

// ── PATCH /users/me ────────────────────────────────────────────────────────────

const updateMeSchema = z.object({
  displayName: z.string().min(1).max(80).optional(),
  bio: z.string().optional(),
  locationText: z.string().max(80).optional(),
  handicapIndex: z.number().optional(),
  avatarInitial: z.string().max(1).optional(),
  homeCourseId: z.string().uuid().optional(),
})

users.patch('/me', authMiddleware, zValidator('json', updateMeSchema), async (c) => {
  const { sub: userId } = c.get('user')
  const body = c.req.valid('json')

  const data = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(body.displayName !== undefined && { displayName: body.displayName }),
      ...(body.bio !== undefined && { bio: body.bio }),
      ...(body.locationText !== undefined && { locationText: body.locationText }),
      ...(body.handicapIndex !== undefined && { handicapIndex: body.handicapIndex }),
      ...(body.avatarInitial !== undefined && { avatarInitial: body.avatarInitial }),
      ...(body.homeCourseId !== undefined && { homeCourseId: body.homeCourseId }),
    },
    select: {
      id: true,
      displayName: true,
      avatarInitial: true,
      avatarUrl: true,
      bio: true,
      locationText: true,
      handicapIndex: true,
      memberSince: true,
      homeCourse: { select: { id: true, name: true, locationText: true } },
    },
  })

  return c.json({ data })
})

// ── GET /users/:id ─────────────────────────────────────────────────────────────

users.get('/:id', async (c) => {
  const id = c.req.param('id')

  const data = await prisma.user.findUnique({
    where: { id, deletedAt: null },
    select: {
      id: true,
      displayName: true,
      avatarInitial: true,
      avatarUrl: true,
      bio: true,
      locationText: true,
      handicapIndex: true,
      memberSince: true,
      homeCourse: { select: { id: true, name: true, locationText: true } },
    },
  })

  if (!data) return c.json({ error: 'User not found' }, 404)

  return c.json({ data })
})

// ── GET /users/:id/stats ───────────────────────────────────────────────────────
// Public profile stats. "rounds" = rounds the user hosts or is accepted into;
// "following" = active community memberships (this app has no user-follow graph).

users.get('/:id/stats', async (c) => {
  const id = c.req.param('id')

  const [roundsCount, followingCount] = await Promise.all([
    prisma.roundParticipant.count({
      where: { userId: id, role: { in: ['host', 'accepted'] }, round: { status: { not: 'cancelled' } } },
    }),
    prisma.communityMember.count({ where: { userId: id, status: 'active' } }),
  ])

  return c.json({ data: { roundsCount, followingCount } })
})

// ── GET /users/:id/rounds ──────────────────────────────────────────────────────
// The user's own rounds (host or accepted), excluding cancelled. `when=past`
// returns finished rounds newest-first; `upcoming` (default) returns the schedule
// soonest-first. Same relation shape as GET /rounds so RoundCard can render them.

const roundRelations = {
  hostUser: { select: { id: true, displayName: true, avatarInitial: true } },
  course: { select: { id: true, name: true, locationText: true } },
  participants: { select: { id: true, userId: true, role: true } },
  _count: { select: { participants: true } },
} as const

const userRoundsQuery = z.object({
  when: z.enum(['past', 'upcoming', 'all']).default('upcoming'),
  limit: z.coerce.number().int().min(1).max(50).default(10),
})

users.get('/:id/rounds', zValidator('query', userRoundsQuery), async (c) => {
  const id = c.req.param('id')
  const { when, limit } = c.req.valid('query')

  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = {
    status: { not: 'cancelled' },
    participants: { some: { userId: id, role: { in: ['host', 'accepted'] } } },
  }
  if (when === 'past') where.date = { lt: today }
  else if (when === 'upcoming') where.date = { gte: today }

  const data = await prisma.round.findMany({
    where,
    include: roundRelations,
    orderBy: { date: when === 'past' ? 'desc' : 'asc' },
    take: limit,
  })

  return c.json({ data })
})

export default users
