import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { authMiddleware } from '../middleware/auth'
import { createNotification } from '../lib/notifications'

const rounds = new Hono()

// ── Shared selects ─────────────────────────────────────────────────────────────

const hostUserSelect = {
  id: true,
  displayName: true,
  avatarInitial: true,
  avatarUrl: true,
} as const

const courseSelect = {
  id: true,
  name: true,
  locationText: true,
  coverPhotoUrl: true,
  lat: true,
  lng: true,
} as const

const participantSelect = {
  id: true,
  userId: true,
  role: true,
  joinedAt: true, // lets the client show the 1-minute back-out window after joining
  user: { select: { id: true, displayName: true, avatarInitial: true, avatarUrl: true } },
} as const

// How long after joining a player may still back out of a round, no questions
// asked. Enforced here (not just in the UI) so the rule can't be bypassed.
const BACKOUT_WINDOW_MS = 60_000

// True when the user already holds a spot (host or accepted) in another active
// round at the exact same date + tee time — i.e. would be double-booked.
async function hasTimeConflict(
  userId: string,
  date: Date,
  teeTime: Date,
  excludeRoundId?: string,
) {
  const clash = await prisma.roundParticipant.findFirst({
    where: {
      userId,
      role: { in: ['host', 'accepted'] },
      ...(excludeRoundId ? { roundId: { not: excludeRoundId } } : {}),
      round: { date, teeTime, status: { not: 'cancelled' } },
    },
    select: { roundId: true },
  })
  return clash != null
}

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
      // A cancelled round is never "your next round" — host-cancel already
      // notifies every participant, so it lives in the bell, not the hero.
      status: { not: 'cancelled' },
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
          user: { select: { id: true, displayName: true, avatarInitial: true, avatarUrl: true } },
        },
      },
    },
  })

  if (!data) return c.json({ error: '找不到球局' }, 404)

  return c.json({ data })
})

// ── POST /rounds ───────────────────────────────────────────────────────────────

const createRoundSchema = z.object({
  courseId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  teeTime: z.string().regex(/^\d{2}:\d{2}$/),
  venueType: z.enum(['course', 'driving_range', 'indoor_sim']),
  // Play format is no longer chosen by the host; stored as a default for now.
  format: z.enum(['stroke_play', 'stableford', 'best_ball', 'scramble']).optional(),
  // Holes only apply to a golf course. Driving ranges and indoor sims omit it
  // (stored as the 18 default but never shown). Required for course venues below.
  holes: z.number().int().refine((n) => n === 9 || n === 18).optional(),
  totalSpots: z.number().int().min(2).max(10),
  greenFeeCents: z.number().int().nonnegative().optional(),
  handicapRequirement: z.enum(['all', 'u10', 'u15', 'u20', 'u28']).optional(),
  visibility: z.enum(['public', 'community']),
  communityId: z.string().uuid().optional(),
  notes: z.string().optional(),
  color1: z.string().optional(),
  color2: z.string().optional(),
}).refine((d) => d.venueType !== 'course' || d.holes != null, {
  message: 'holes is required for a golf course',
  path: ['holes'],
}).refine((d) => d.totalSpots <= (d.venueType === 'course' ? 4 : d.venueType === 'indoor_sim' ? 6 : 10), {
  message: 'totalSpots exceeds the venue maximum (4 course, 6 indoor sim, 10 range)',
  path: ['totalSpots'],
})

rounds.post('/', authMiddleware, zValidator('json', createRoundSchema), async (c) => {
  const { sub: userId } = c.get('user')
  const body = c.req.valid('json')

  // Parse teeTime into a full DateTime (date-agnostic time storage)
  const [hh, mm] = body.teeTime.split(':').map(Number)
  const teeTimeDate = new Date('1970-01-01T00:00:00.000Z')
  teeTimeDate.setUTCHours(hh, mm, 0, 0)

  // No double-booking: the host can't tee off in two places at once.
  if (await hasTimeConflict(userId, new Date(body.date), teeTimeDate)) {
    return c.json({ error: '你在同一時段已有其他球局，無法重複安排' }, 409)
  }

  const data = await prisma.round.create({
    data: {
      hostUserId: userId,
      courseId: body.courseId,
      date: new Date(body.date),
      teeTime: teeTimeDate,
      venueType: body.venueType,
      format: body.format ?? 'stroke_play',
      holes: body.venueType === 'course' ? body.holes : 18,
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

  const round = await prisma.round.findUnique({
    where: { id: roundId },
    include: { participants: { select: { userId: true, role: true } } },
  })
  if (!round) return c.json({ error: '找不到球局' }, 404)
  if (round.status !== 'open') return c.json({ error: '此球局目前不開放加入' }, 400)

  const existing = round.participants.find((p) => p.userId === userId)
  if (existing && (existing.role === 'host' || existing.role === 'accepted')) {
    return c.json({ error: '你已經是參與者' }, 400)
  }

  const taken = round.participants.filter((p) => p.role === 'host' || p.role === 'accepted').length
  if (taken >= round.totalSpots) return c.json({ error: '此球局已額滿' }, 400)

  // No double-booking: block joining when the player already holds a spot in
  // another active round at the same date + tee time.
  if (await hasTimeConflict(userId, round.date, round.teeTime, roundId)) {
    return c.json({ error: '你在同一時段已有其他球局，無法重複報名' }, 409)
  }

  // Free join: players go straight in as 'accepted' (no host approval). A prior
  // request/decline for the same person is upgraded rather than duplicated.
  if (existing) {
    await prisma.roundParticipant.update({
      where: { roundId_userId: { roundId, userId } },
      data: { role: 'accepted' },
    })
  } else {
    await prisma.roundParticipant.create({
      data: { roundId, userId, role: 'accepted' },
    })
  }

  // Let the host know a new player joined (round_accepted opens the round detail).
  const [joiner, course] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { displayName: true } }),
    prisma.course.findUnique({ where: { id: round.courseId }, select: { name: true } }),
  ])
  await createNotification({
    userId: round.hostUserId,
    type: 'round_accepted',
    title: '有新球友加入',
    body: `${joiner?.displayName ?? '有人'} 加入了你在 ${course?.name ?? '你的球場'} 的球局`,
    targetType: 'round',
    targetId: roundId,
  })

  return c.json({ ok: true })
})

// ── POST /rounds/:id/leave (back out within the grace window) ────────────────────

rounds.post('/:id/leave', authMiddleware, async (c) => {
  const { sub: userId } = c.get('user')
  const roundId = c.req.param('id')

  const participant = await prisma.roundParticipant.findUnique({
    where: { roundId_userId: { roundId, userId } },
  })
  if (!participant) return c.json({ error: '你不在此球局中' }, 404)
  if (participant.role === 'host') {
    return c.json({ error: '主辦者無法退出，請改為取消球局' }, 400)
  }
  if (Date.now() - participant.joinedAt.getTime() > BACKOUT_WINDOW_MS) {
    return c.json({ error: '已超過退出時限（僅限加入後一分鐘內）' }, 403)
  }

  await prisma.roundParticipant.delete({
    where: { roundId_userId: { roundId, userId } },
  })

  return c.json({ ok: true })
})

// ── POST /rounds/:id/invite (host fills an open spot directly) ───────────────────

const inviteSchema = z.object({ userId: z.string().uuid() })

rounds.post('/:id/invite', authMiddleware, zValidator('json', inviteSchema), async (c) => {
  const { sub: hostId } = c.get('user')
  const roundId = c.req.param('id')
  const { userId: inviteeId } = c.req.valid('json')

  const round = await prisma.round.findUnique({
    where: { id: roundId },
    include: { participants: { select: { role: true } } },
  })
  if (!round) return c.json({ error: '找不到球局' }, 404)
  if (round.hostUserId !== hostId) return c.json({ error: '只有主辦者可以邀請球友' }, 403)
  if (round.status !== 'open') return c.json({ error: '此球局目前不開放加入' }, 400)

  const taken = round.participants.filter((p) => p.role === 'host' || p.role === 'accepted').length
  if (taken >= round.totalSpots) return c.json({ error: '名額已滿' }, 400)

  const invitee = await prisma.user.findUnique({ where: { id: inviteeId }, select: { id: true } })
  if (!invitee) return c.json({ error: '找不到該使用者' }, 404)

  // Host vouches for invitees, so they go straight in as 'accepted'. A prior
  // request/decline for the same person is upgraded rather than duplicated.
  const existing = await prisma.roundParticipant.findUnique({
    where: { roundId_userId: { roundId, userId: inviteeId } },
  })
  if (existing && (existing.role === 'host' || existing.role === 'accepted')) {
    return c.json({ error: '對方已經在這場球局中' }, 400)
  }
  if (existing) {
    await prisma.roundParticipant.update({
      where: { roundId_userId: { roundId, userId: inviteeId } },
      data: { role: 'accepted' },
    })
  } else {
    await prisma.roundParticipant.create({ data: { roundId, userId: inviteeId, role: 'accepted' } })
  }

  const [host, course] = await Promise.all([
    prisma.user.findUnique({ where: { id: hostId }, select: { displayName: true } }),
    prisma.course.findUnique({ where: { id: round.courseId }, select: { name: true } }),
  ])
  await createNotification({
    userId: inviteeId,
    type: 'round_accepted', // reuses the closest existing enum (invitee is now in the round)
    title: '球局邀請',
    body: `${host?.displayName ?? '主辦者'} 邀請你加入 ${course?.name ?? '球場'} 的球局`,
    targetType: 'round',
    targetId: roundId,
  })

  const data = await prisma.round.findUnique({
    where: { id: roundId },
    include: {
      hostUser: { select: hostUserSelect },
      course: { select: courseSelect },
      participants: { select: participantSelect },
    },
  })
  return c.json({ data })
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
  if (!round) return c.json({ error: '找不到球局' }, 404)
  if (round.hostUserId !== userId) return c.json({ error: '只有主辦者可以編輯此球局' }, 403)

  // Snapshot date/tee-time so we can tell whether the *schedule* actually changed
  // (vs. an edit that only touches spots/notes) — only a schedule change warrants
  // pinging the players who already committed.
  const prevDateIso = round.date.toISOString().slice(0, 10)
  const prevTee = `${String(round.teeTime.getUTCHours()).padStart(2, '0')}:${String(round.teeTime.getUTCMinutes()).padStart(2, '0')}`

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

  // If the date or tee-time moved, let everyone already in the round know.
  const newDate = body.date ?? prevDateIso
  const newTee = body.teeTime ?? prevTee
  const scheduleChanged = newDate !== prevDateIso || newTee !== prevTee
  if (scheduleChanged) {
    const recipients = data.participants.filter(
      (p) => p.userId !== data.hostUserId && (p.role === 'accepted' || p.role === 'waitlisted'),
    )
    await Promise.all(
      recipients.map((p) =>
        createNotification({
          userId: p.userId,
          type: 'round_reminder', // reuses the closest existing enum (a schedule alert)
          title: '球局時間有異動',
          body: `${data.course?.name ?? '球場'} 的球局已改至 ${newDate} ${newTee}`,
          targetType: 'round',
          targetId: id,
        }),
      ),
    )
  }

  return c.json({ data })
})

// ── DELETE /rounds/:id (host-only cancel) ───────────────────────────────────────

rounds.delete('/:id', authMiddleware, async (c) => {
  const { sub: userId } = c.get('user')
  const id = c.req.param('id')

  const round = await prisma.round.findUnique({
    where: { id },
    include: {
      course: { select: { name: true } },
      participants: { select: { userId: true, role: true } },
    },
  })
  if (!round) return c.json({ error: '找不到球局' }, 404)
  if (round.hostUserId !== userId) return c.json({ error: '只有主辦者可以取消此球局' }, 403)

  const data = await prisma.round.update({ where: { id }, data: { status: 'cancelled' } })

  // Tell everyone who joined or asked to join (not the host) that it's off.
  const recipients = round.participants.filter(
    (p) =>
      p.userId !== round.hostUserId &&
      (p.role === 'accepted' || p.role === 'requested' || p.role === 'waitlisted'),
  )
  await Promise.all(
    recipients.map((p) =>
      createNotification({
        userId: p.userId,
        type: 'round_reminder', // reuses the closest existing enum (a schedule alert)
        title: '球局已取消',
        body: `${round.course?.name ?? '球場'} 的球局已被主辦者取消`,
        targetType: 'round',
        targetId: id,
      }),
    ),
  )

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
  if (!round) return c.json({ error: '找不到球局' }, 404)
  if (round.hostUserId !== hostId) return c.json({ error: '只有主辦者可以管理申請' }, 403)

  const participant = await prisma.roundParticipant.findUnique({
    where: { roundId_userId: { roundId, userId: targetUserId } },
  })
  if (!participant) return c.json({ error: '找不到參與者' }, 404)

  const data = await prisma.roundParticipant.update({
    where: { roundId_userId: { roundId, userId: targetUserId } },
    data: { role },
  })

  // Notify the requester when they're accepted.
  if (role === 'accepted') {
    const [host, course] = await Promise.all([
      prisma.user.findUnique({ where: { id: hostId }, select: { displayName: true } }),
      prisma.course.findUnique({ where: { id: round.courseId }, select: { name: true } }),
    ])
    await createNotification({
      userId: targetUserId,
      type: 'round_accepted',
      title: '申請已通過',
      body: `${host?.displayName ?? '主辦者'} 已通過你加入 ${course?.name ?? '該球場'} 球局的申請`,
      targetType: 'round',
      targetId: roundId,
    })
  }

  return c.json({ data })
})

export default rounds
