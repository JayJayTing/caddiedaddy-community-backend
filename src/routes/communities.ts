import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { authMiddleware } from '../middleware/auth'

const communities = new Hono()

// ── Shared selects ─────────────────────────────────────────────────────────────

const creatorSelect = {
  id: true,
  displayName: true,
  avatarInitial: true,
  avatarUrl: true,
} as const

// Full community detail (creator + home course + active members + counts). Reused
// by GET /:id and the join/leave endpoints so they all return the same shape.
function loadCommunityDetail(id: string) {
  return prisma.community.findUnique({
    where: { id },
    include: {
      creator: { select: creatorSelect },
      homeCourse: { select: { id: true, name: true, locationText: true } },
      members: {
        where: { status: 'active' },
        include: {
          user: { select: { id: true, displayName: true, avatarInitial: true, avatarUrl: true, handicapIndex: true } },
        },
        orderBy: { joinedAt: 'asc' },
      },
      _count: { select: { members: true, rounds: true } },
    },
  })
}

// ── GET /communities ───────────────────────────────────────────────────────────

communities.get('/', async (c) => {
  const data = await prisma.community.findMany({
    where: {
      privacy: { in: ['public', 'invite_only'] },
      deletedAt: null,
    },
    include: {
      creator: { select: creatorSelect },
      _count: { select: { members: true, rounds: true } },
    },
    orderBy: { memberCount: 'desc' },
  })

  return c.json({ data })
})

// ── GET /communities/mine ──────────────────────────────────────────────────────

communities.get('/mine', authMiddleware, async (c) => {
  const { sub: userId } = c.get('user')

  const data = await prisma.community.findMany({
    where: {
      deletedAt: null,
      members: {
        some: { userId, status: 'active' },
      },
    },
    include: {
      creator: { select: creatorSelect },
      _count: { select: { members: true, rounds: true } },
    },
    orderBy: { memberCount: 'desc' },
  })

  return c.json({ data })
})

// ── GET /communities/:id ───────────────────────────────────────────────────────

communities.get('/:id', async (c) => {
  const id = c.req.param('id')

  const data = await loadCommunityDetail(id)

  if (!data || data.deletedAt) return c.json({ error: '找不到社群' }, 404)

  return c.json({ data })
})

// ── POST /communities ──────────────────────────────────────────────────────────

const createCommunitySchema = z.object({
  name: z.string().min(1).max(80),
  type: z.enum(['mixed', 'mens_club', 'ladies_club', 'corporate', 'beginner']),
  privacy: z.enum(['public', 'invite_only', 'private']),
  description: z.string().optional(),
  color1: z.string().optional(),
  color2: z.string().optional(),
  homeCourseId: z.string().uuid().optional(),
})

communities.post('/', authMiddleware, zValidator('json', createCommunitySchema), async (c) => {
  const { sub: userId } = c.get('user')
  const body = c.req.valid('json')

  const data = await prisma.community.create({
    data: {
      creatorId: userId,
      name: body.name,
      type: body.type,
      privacy: body.privacy,
      description: body.description,
      color1: body.color1,
      color2: body.color2,
      homeCourseId: body.homeCourseId,
      memberCount: 1,
      members: {
        create: { userId, role: 'admin', status: 'active' },
      },
    },
    include: {
      creator: { select: creatorSelect },
      _count: { select: { members: true, rounds: true } },
    },
  })

  return c.json({ data }, 201)
})

// ── POST /communities/:id/join ───────────────────────────────────────────────────

communities.post('/:id/join', authMiddleware, async (c) => {
  const { sub: userId } = c.get('user')
  const id = c.req.param('id')

  const community = await prisma.community.findUnique({
    where: { id },
    select: { id: true, privacy: true, deletedAt: true },
  })
  if (!community || community.deletedAt) return c.json({ error: '找不到社群' }, 404)
  if (community.privacy === 'private') {
    return c.json({ error: '此社群為私人社群，需要邀請才能加入' }, 403)
  }

  const existing = await prisma.communityMember.findUnique({
    where: { communityId_userId: { communityId: id, userId } },
  })

  // Idempotent: only mutate (and bump the denormalized count) when the user is not
  // already an active member.
  if (!existing) {
    await prisma.$transaction([
      prisma.communityMember.create({
        data: { communityId: id, userId, role: 'member', status: 'active' },
      }),
      prisma.community.update({ where: { id }, data: { memberCount: { increment: 1 } } }),
    ])
  } else if (existing.status !== 'active') {
    await prisma.$transaction([
      prisma.communityMember.update({
        where: { communityId_userId: { communityId: id, userId } },
        data: { status: 'active' },
      }),
      prisma.community.update({ where: { id }, data: { memberCount: { increment: 1 } } }),
    ])
  }

  const data = await loadCommunityDetail(id)
  return c.json({ data })
})

// ── POST /communities/:id/leave ──────────────────────────────────────────────────

communities.post('/:id/leave', authMiddleware, async (c) => {
  const { sub: userId } = c.get('user')
  const id = c.req.param('id')

  const community = await prisma.community.findUnique({
    where: { id },
    select: { id: true, creatorId: true, deletedAt: true },
  })
  if (!community || community.deletedAt) return c.json({ error: '找不到社群' }, 404)
  if (community.creatorId === userId) {
    return c.json({ error: '建立者無法退出自己建立的社群' }, 400)
  }

  const existing = await prisma.communityMember.findUnique({
    where: { communityId_userId: { communityId: id, userId } },
  })

  if (existing && existing.status === 'active') {
    await prisma.$transaction([
      prisma.communityMember.delete({
        where: { communityId_userId: { communityId: id, userId } },
      }),
      prisma.community.update({ where: { id }, data: { memberCount: { decrement: 1 } } }),
    ])
  }

  const data = await loadCommunityDetail(id)
  return c.json({ data })
})

export default communities
