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

export default users
