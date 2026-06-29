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

// ── Friends / connections ───────────────────────────────────────────────────────
// Backed by the existing `user_connections` table (directional row, bidirectional
// once accepted). No new schema. Friend-request notifications are intentionally
// surfaced in the Find-Players UI (a Requests list), not the notification enum.

const playerSelect = {
  id: true,
  displayName: true,
  avatarUrl: true,
  avatarInitial: true,
  locationText: true,
  handicapIndex: true,
} as const

type Relation = 'none' | 'friends' | 'outgoing' | 'incoming'

// The connection row between two users, in whichever direction it exists.
function connectionBetween(meId: string, otherId: string) {
  return prisma.userConnection.findFirst({
    where: {
      OR: [
        { initiatorId: meId, recipientId: otherId },
        { initiatorId: otherId, recipientId: meId },
      ],
    },
  })
}

// GET /users/search?q= — find players by name, each tagged with my relation to them.
users.get(
  '/search',
  authMiddleware,
  zValidator('query', z.object({ q: z.string().trim().min(1).max(50) })),
  async (c) => {
    const { sub: meId } = c.get('user')
    const { q } = c.req.valid('query')

    const found = await prisma.user.findMany({
      where: { deletedAt: null, id: { not: meId }, displayName: { contains: q, mode: 'insensitive' } },
      select: playerSelect,
      take: 20,
      orderBy: { displayName: 'asc' },
    })

    const ids = found.map((u) => u.id)
    const conns = ids.length
      ? await prisma.userConnection.findMany({
          where: {
            OR: [
              { initiatorId: meId, recipientId: { in: ids } },
              { recipientId: meId, initiatorId: { in: ids } },
            ],
          },
        })
      : []

    const relationFor = (uid: string): Relation => {
      const conn = conns.find(
        (cn) =>
          (cn.initiatorId === meId && cn.recipientId === uid) ||
          (cn.recipientId === meId && cn.initiatorId === uid),
      )
      if (!conn) return 'none'
      if (conn.status === 'accepted') return 'friends'
      if (conn.status === 'pending') return conn.initiatorId === meId ? 'outgoing' : 'incoming'
      return 'none'
    }

    return c.json({ data: found.map((u) => ({ ...u, relation: relationFor(u.id) })) })
  },
)

// GET /users/friends — my accepted friends.
users.get('/friends', authMiddleware, async (c) => {
  const { sub: meId } = c.get('user')
  const conns = await prisma.userConnection.findMany({
    where: { status: 'accepted', OR: [{ initiatorId: meId }, { recipientId: meId }] },
    include: { initiator: { select: playerSelect }, recipient: { select: playerSelect } },
    orderBy: { updatedAt: 'desc' },
  })
  const friends = conns.map((cn) => (cn.initiatorId === meId ? cn.recipient : cn.initiator))
  return c.json({ data: friends })
})

// GET /users/friends/requests — incoming friend requests (people who added me).
users.get('/friends/requests', authMiddleware, async (c) => {
  const { sub: meId } = c.get('user')
  const conns = await prisma.userConnection.findMany({
    where: { recipientId: meId, status: 'pending' },
    include: { initiator: { select: playerSelect } },
    orderBy: { initiatedAt: 'desc' },
  })
  return c.json({ data: conns.map((cn) => cn.initiator) })
})

// POST /users/friends/:userId/request — add a player. If they already requested me,
// this accepts; if we're already connected, it's a no-op.
users.post('/friends/:userId/request', authMiddleware, async (c) => {
  const { sub: meId } = c.get('user')
  const otherId = c.req.param('userId')
  if (otherId === meId) return c.json({ error: '無法加入自己' }, 400)

  const target = await prisma.user.findUnique({ where: { id: otherId, deletedAt: null }, select: { id: true } })
  if (!target) return c.json({ error: '找不到使用者' }, 404)

  const existing = await connectionBetween(meId, otherId)
  if (existing) {
    if (existing.status === 'accepted') return c.json({ data: { status: 'accepted' } })
    if (existing.status === 'pending') {
      if (existing.recipientId === meId) {
        await prisma.userConnection.update({ where: { id: existing.id }, data: { status: 'accepted' } })
        return c.json({ data: { status: 'accepted' } })
      }
      return c.json({ data: { status: 'pending' } })
    }
    // declined / blocked → reopen as a fresh request from me
    await prisma.userConnection.update({
      where: { id: existing.id },
      data: { status: 'pending', initiatorId: meId, recipientId: otherId },
    })
    return c.json({ data: { status: 'pending' } })
  }

  await prisma.userConnection.create({ data: { initiatorId: meId, recipientId: otherId, status: 'pending' } })
  return c.json({ data: { status: 'pending' } }, 201)
})

// POST /users/friends/:userId/accept — accept an incoming request.
users.post('/friends/:userId/accept', authMiddleware, async (c) => {
  const { sub: meId } = c.get('user')
  const otherId = c.req.param('userId')
  const conn = await prisma.userConnection.findFirst({
    where: { initiatorId: otherId, recipientId: meId, status: 'pending' },
  })
  if (!conn) return c.json({ error: '找不到此邀請' }, 404)
  await prisma.userConnection.update({ where: { id: conn.id }, data: { status: 'accepted' } })
  return c.json({ data: { status: 'accepted' } })
})

// POST /users/friends/:userId/decline — decline an incoming request (removes it).
users.post('/friends/:userId/decline', authMiddleware, async (c) => {
  const { sub: meId } = c.get('user')
  const otherId = c.req.param('userId')
  const conn = await prisma.userConnection.findFirst({
    where: { initiatorId: otherId, recipientId: meId, status: 'pending' },
  })
  if (!conn) return c.json({ error: '找不到此邀請' }, 404)
  await prisma.userConnection.delete({ where: { id: conn.id } })
  return c.json({ data: { status: 'declined' } })
})

// DELETE /users/friends/:userId — unfriend, or cancel an outgoing request.
users.delete('/friends/:userId', authMiddleware, async (c) => {
  const { sub: meId } = c.get('user')
  const otherId = c.req.param('userId')
  const conn = await connectionBetween(meId, otherId)
  if (conn) await prisma.userConnection.delete({ where: { id: conn.id } })
  return c.json({ data: { ok: true } })
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

  if (!data) return c.json({ error: '找不到使用者' }, 404)

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
