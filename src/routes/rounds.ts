import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { authMiddleware } from '../middleware/auth'

const rounds = new Hono()

// ── Shared selects ─────────────────────────────────────────────────────────────

const hostUserSelect = {
  id: true,
  displayName: true,
  avatarInitial: true,
} as const

const courseSelect = {
  id: true,
  name: true,
  locationText: true,
} as const

const participantSelect = {
  id: true,
  userId: true,
  role: true,
} as const

// ── GET /rounds ────────────────────────────────────────────────────────────────

const listQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  format: z.enum(['stroke_play', 'stableford', 'best_ball', 'scramble']).optional(),
  holes: z.enum(['9', '18']).transform(Number).optional(),
  handicap: z.enum(['all', 'u10', 'u15', 'u20', 'u28']).optional(),
  communityId: z.string().uuid().optional(),
  timeOfDay: z.enum(['morning', 'afternoon']).optional(),
})

rounds.get('/', zValidator('query', listQuerySchema), async (c) => {
  const { date, format, holes, handicap, communityId, timeOfDay } = c.req.valid('query')

  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = {
    status: 'open',
    date: { gte: date ? new Date(date) : today },
  }

  if (date) where.date = { gte: new Date(date) }
  if (format) where.format = format
  if (holes) where.holes = holes
  if (handicap) where.handicapRequirement = handicap
  if (communityId) where.communityId = communityId

  if (timeOfDay === 'morning') {
    // teeTime < 12:00 — stored as full DateTime, compare time component
    where.teeTime = { lt: new Date('1970-01-01T12:00:00.000Z') }
  } else if (timeOfDay === 'afternoon') {
    where.teeTime = { gte: new Date('1970-01-01T12:00:00.000Z') }
  }

  const data = await prisma.round.findMany({
    where,
    include: {
      hostUser: { select: hostUserSelect },
      course: { select: courseSelect },
      participants: { select: participantSelect },
      _count: { select: { participants: true } },
    },
    orderBy: [{ date: 'asc' }, { teeTime: 'asc' }],
  })

  return c.json({ data })
})

// ── GET /rounds/upcoming ───────────────────────────────────────────────────────

rounds.get('/upcoming', authMiddleware, async (c) => {
  const { sub: userId } = c.get('user')

  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)

  const data = await prisma.round.findMany({
    where: {
      date: { gte: today },
      participants: {
        some: {
          userId,
          role: { in: ['host', 'accepted'] },
        },
      },
    },
    include: {
      hostUser: { select: hostUserSelect },
      course: { select: courseSelect },
      participants: { select: participantSelect },
      _count: { select: { participants: true } },
    },
    orderBy: { date: 'asc' },
  })

  return c.json({ data })
})

// ── GET /rounds/:id ────────────────────────────────────────────────────────────

rounds.get('/:id', async (c) => {
  const id = c.req.param('id')

  const data = await prisma.round.findUnique({
    where: { id },
    include: {
      hostUser: { select: hostUserSelect },
      course: { select: courseSelect },
      community: { select: { id: true, name: true } },
      participants: {
        select: {
          userId: true,
          role: true,
          joinedAt: true,
          user: { select: { id: true, displayName: true, avatarInitial: true } },
        },
      },
    },
  })

  if (!data) return c.json({ error: 'Round not found' }, 404)

  return c.json({ data })
})

// ── POST /rounds ───────────────────────────────────────────────────────────────

const createRoundSchema = z.object({
  courseId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  teeTime: z.string().regex(/^\d{2}:\d{2}$/),
  venueType: z.enum(['course', 'driving_range']),
  format: z.enum(['stroke_play', 'stableford', 'best_ball', 'scramble']),
  holes: z.number().int().refine((n) => n === 9 || n === 18),
  totalSpots: z.number().int().min(2),
  greenFeeCents: z.number().int().nonnegative().optional(),
  handicapRequirement: z.enum(['all', 'u10', 'u15', 'u20', 'u28']).optional(),
  visibility: z.enum(['public', 'community']),
  communityId: z.string().uuid().optional(),
  notes: z.string().optional(),
  color1: z.string().optional(),
  color2: z.string().optional(),
})

rounds.post('/', authMiddleware, zValidator('json', createRoundSchema), async (c) => {
  const { sub: userId } = c.get('user')
  const body = c.req.valid('json')

  // Parse teeTime into a full DateTime (date-agnostic time storage)
  const [hh, mm] = body.teeTime.split(':').map(Number)
  const teeTimeDate = new Date('1970-01-01T00:00:00.000Z')
  teeTimeDate.setUTCHours(hh, mm, 0, 0)

  const data = await prisma.round.create({
    data: {
      hostUserId: userId,
      courseId: body.courseId,
      date: new Date(body.date),
      teeTime: teeTimeDate,
      venueType: body.venueType,
      format: body.format,
      holes: body.holes,
      totalSpots: body.totalSpots,
      greenFeeCents: body.greenFeeCents,
      handicapRequirement: body.handicapRequirement,
      visibility: body.visibility,
      communityId: body.communityId,
      notes: body.notes,
      color1: body.color1,
      color2: body.color2,
      participants: {
        create: { userId, role: 'host' },
      },
    },
    include: {
      hostUser: { select: hostUserSelect },
      course: { select: courseSelect },
      participants: { select: participantSelect },
    },
  })

  return c.json({ data }, 201)
})

// ── POST /rounds/:id/join ──────────────────────────────────────────────────────

rounds.post('/:id/join', authMiddleware, async (c) => {
  const { sub: userId } = c.get('user')
  const roundId = c.req.param('id')

  const round = await prisma.round.findUnique({ where: { id: roundId } })
  if (!round) return c.json({ error: 'Round not found' }, 404)
  if (round.status !== 'open') return c.json({ error: 'Round is not open for joining' }, 400)

  const existing = await prisma.roundParticipant.findUnique({
    where: { roundId_userId: { roundId, userId } },
  })
  if (existing) return c.json({ error: 'Already a participant' }, 400)

  await prisma.roundParticipant.create({
    data: { roundId, userId, role: 'requested' },
  })

  return c.json({ ok: true })
})

// ── PATCH /rounds/:id (host-only edit) ──────────────────────────────────────────

const editRoundSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  teeTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  format: z.enum(['stroke_play', 'stableford', 'best_ball', 'scramble']).optional(),
  holes: z.number().int().refine((n) => n === 9 || n === 18).optional(),
  totalSpots: z.number().int().min(2).optional(),
  greenFeeCents: z.number().int().nonnegative().nullable().optional(),
  handicapRequirement: z.enum(['all', 'u10', 'u15', 'u20', 'u28']).optional(),
  notes: z.string().nullable().optional(),
})

rounds.patch('/:id', authMiddleware, zValidator('json', editRoundSchema), async (c) => {
  const { sub: userId } = c.get('user')
  const id = c.req.param('id')
  const body = c.req.valid('json')

  const round = await prisma.round.findUnique({ where: { id } })
  if (!round) return c.json({ error: 'Round not found' }, 404)
  if (round.hostUserId !== userId) return c.json({ error: 'Only the host can edit this round' }, 403)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateData: Record<string, any> = {}
  if (body.date !== undefined) updateData.date = new Date(body.date)
  if (body.teeTime !== undefined) {
    const [hh, mm] = body.teeTime.split(':').map(Number)
    const t = new Date('1970-01-01T00:00:00.000Z')
    t.setUTCHours(hh, mm, 0, 0)
    updateData.teeTime = t
  }
  if (body.format !== undefined) updateData.format = body.format
  if (body.holes !== undefined) updateData.holes = body.holes
  if (body.totalSpots !== undefined) updateData.totalSpots = body.totalSpots
  if (body.greenFeeCents !== undefined) updateData.greenFeeCents = body.greenFeeCents
  if (body.handicapRequirement !== undefined) updateData.handicapRequirement = body.handicapRequirement
  if (body.notes !== undefined) updateData.notes = body.notes

  const data = await prisma.round.update({
    where: { id },
    data: updateData,
    include: {
      hostUser: { select: hostUserSelect },
      course: { select: courseSelect },
      participants: { select: participantSelect },
    },
  })

  return c.json({ data })
})

// ── DELETE /rounds/:id (host-only cancel) ───────────────────────────────────────

rounds.delete('/:id', authMiddleware, async (c) => {
  const { sub: userId } = c.get('user')
  const id = c.req.param('id')

  const round = await prisma.round.findUnique({ where: { id } })
  if (!round) return c.json({ error: 'Round not found' }, 404)
  if (round.hostUserId !== userId) return c.json({ error: 'Only the host can cancel this round' }, 403)

  const data = await prisma.round.update({ where: { id }, data: { status: 'cancelled' } })
  return c.json({ data })
})

// ── PATCH /rounds/:id/participants/:userId (host accept/decline/waitlist) ────────

const participantRoleSchema = z.object({
  role: z.enum(['accepted', 'declined', 'waitlisted']),
})

rounds.patch('/:id/participants/:userId', authMiddleware, zValidator('json', participantRoleSchema), async (c) => {
  const { sub: hostId } = c.get('user')
  const roundId = c.req.param('id')
  const targetUserId = c.req.param('userId')
  const { role } = c.req.valid('json')

  const round = await prisma.round.findUnique({ where: { id: roundId } })
  if (!round) return c.json({ error: 'Round not found' }, 404)
  if (round.hostUserId !== hostId) return c.json({ error: 'Only the host can manage requests' }, 403)

  const participant = await prisma.roundParticipant.findUnique({
    where: { roundId_userId: { roundId, userId: targetUserId } },
  })
  if (!participant) return c.json({ error: 'Participant not found' }, 404)

  const data = await prisma.roundParticipant.update({
    where: { roundId_userId: { roundId, userId: targetUserId } },
    data: { role },
  })

  return c.json({ data })
})

export default rounds
