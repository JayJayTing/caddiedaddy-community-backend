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

// How many communities a free user may create. Kept in one place (env-overridable)
// so tuning it is a one-liner. A future premium tier will raise this — see
// communityCreationLimit() below.
const FREE_COMMUNITY_LIMIT = Number(process.env.COMMUNITY_LIMIT_FREE ?? 2)

// The community-creation cap for a given user. Everyone is on the free tier today;
// when premium ships, branch on the user's plan here (e.g. return Infinity / a
// higher number for subscribers) and this is the only spot that has to change.
function communityCreationLimit(_userId: string): number {
  return FREE_COMMUNITY_LIMIT
}

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

  // Enforce the per-user creation cap. Count only live communities the user still
  // owns (soft-deleted ones free up a slot). Source of truth for the limit — the
  // frontend gates the UI too, but this is what actually protects the data.
  const limit = communityCreationLimit(userId)
  const owned = await prisma.community.count({
    where: { creatorId: userId, deletedAt: null },
  })
  if (owned >= limit) {
    return c.json({ error: `每位用戶最多只能建立 ${limit} 個社群` }, 403)
  }

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

// ── DELETE /communities/:id/members/:userId (owner removes a member) ──────────────

communities.delete('/:id/members/:userId', authMiddleware, async (c) => {
  const { sub: actorId } = c.get('user')
  const id = c.req.param('id')
  const targetUserId = c.req.param('userId')

  const community = await prisma.community.findUnique({
    where: { id },
    select: { id: true, creatorId: true, deletedAt: true },
  })
  if (!community || community.deletedAt) return c.json({ error: '找不到球隊' }, 404)
  // Only the owner (creator) may remove members.
  if (community.creatorId !== actorId) {
    return c.json({ error: '只有球隊擁有者可以移除成員' }, 403)
  }
  // The owner can't remove themselves this way (they'd dissolve the team).
  if (targetUserId === community.creatorId) {
    return c.json({ error: '無法移除球隊擁有者' }, 400)
  }

  const existing = await prisma.communityMember.findUnique({
    where: { communityId_userId: { communityId: id, userId: targetUserId } },
  })
  if (existing && existing.status === 'active') {
    await prisma.$transaction([
      prisma.communityMember.delete({
        where: { communityId_userId: { communityId: id, userId: targetUserId } },
      }),
      prisma.community.update({ where: { id }, data: { memberCount: { decrement: 1 } } }),
    ])
  }

  const data = await loadCommunityDetail(id)
  return c.json({ data })
})

export default communities
