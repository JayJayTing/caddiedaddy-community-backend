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
} as const

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

  const data = await prisma.community.findUnique({
    where: { id },
    include: {
      creator: { select: creatorSelect },
      homeCourse: { select: { id: true, name: true, locationText: true } },
      members: {
        where: { status: 'active' },
        include: {
          user: { select: { id: true, displayName: true, avatarInitial: true } },
        },
      },
      _count: { select: { members: true, rounds: true } },
    },
  })

  if (!data) return c.json({ error: 'Community not found' }, 404)

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

export default communities
