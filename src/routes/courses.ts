import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { authMiddleware } from '../middleware/auth'
import { adminMiddleware } from '../middleware/admin'

const courses = new Hono()

// Fields exposed to consumers — drives both search results and map pins.
const publicCourseSelect = {
  id: true,
  name: true,
  locationText: true,
  district: true,
  city: true,
  holeCount: true,
  venueType: true,
  lat: true,
  lng: true,
  coverPhotoUrl: true,
  photos: true,
} as const

// ── GET /courses ─── approved courses for search + map pins ──────────────────────
// `q` filters by name (host flow / search box); omitted returns all approved
// courses so the explore map can drop every pin.

const listQuerySchema = z.object({
  q: z.string().min(1).optional(),
})

courses.get('/', zValidator('query', listQuerySchema), async (c) => {
  const { q } = c.req.valid('query')

  const data = await prisma.course.findMany({
    where: {
      status: 'approved',
      ...(q ? { name: { contains: q, mode: 'insensitive' as const } } : {}),
    },
    select: publicCourseSelect,
    orderBy: { name: 'asc' },
    take: 200,
  })

  return c.json({ data })
})

// ── POST /courses ─── submit a golf location for review (any logged-in user) ─────
// Lands as `pending`; an admin approves it via the moderation routes below.

const submitCourseSchema = z.object({
  name: z.string().min(2).max(100),
  locationText: z.string().max(80).optional(),
  district: z.string().max(40).optional(),
  city: z.string().max(40).optional(),
  holeCount: z.number().int().min(1).max(36).optional(),
  venueType: z.enum(['course', 'driving_range']).optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  coverPhotoUrl: z.string().url().optional(),
  photos: z.array(z.string().url()).max(10).optional(),
})

courses.post('/', authMiddleware, zValidator('json', submitCourseSchema), async (c) => {
  const { sub: userId } = c.get('user')
  const body = c.req.valid('json')

  const data = await prisma.course.create({
    data: {
      name: body.name,
      locationText: body.locationText,
      district: body.district,
      city: body.city,
      holeCount: body.holeCount ?? 18,
      venueType: body.venueType ?? 'course',
      lat: body.lat,
      lng: body.lng,
      coverPhotoUrl: body.coverPhotoUrl,
      photos: body.photos ?? [],
      status: 'pending',
      submittedById: userId,
    },
    select: publicCourseSelect,
  })

  return c.json({ data }, 201)
})

// ── Admin moderation ─────────────────────────────────────────────────────────────
// Gated by the ADMIN_USER_IDS allowlist (middleware/admin.ts). Registered under a
// static `/admin/...` namespace BEFORE the consumer `/:id` route so the paths
// never collide.

const queueQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).default('pending'),
})

courses.get('/admin/queue', adminMiddleware, zValidator('query', queueQuerySchema), async (c) => {
  const { status } = c.req.valid('query')

  const data = await prisma.course.findMany({
    where: { status },
    include: {
      submittedBy: {
        select: { id: true, displayName: true, avatarInitial: true, avatarUrl: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  return c.json({ data })
})

const moderateCourseSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
  name: z.string().min(2).max(100).optional(),
  locationText: z.string().max(80).nullable().optional(),
  district: z.string().max(40).nullable().optional(),
  city: z.string().max(40).nullable().optional(),
  holeCount: z.number().int().min(1).max(36).optional(),
  venueType: z.enum(['course', 'driving_range']).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  coverPhotoUrl: z.string().url().nullable().optional(),
  photos: z.array(z.string().url()).max(10).optional(),
  rejectionReason: z.string().max(500).nullable().optional(),
})

// Editable scalar fields an admin may patch alongside an approve/reject.
const moderatableFields = [
  'name',
  'locationText',
  'district',
  'city',
  'holeCount',
  'venueType',
  'lat',
  'lng',
  'coverPhotoUrl',
  'photos',
  'rejectionReason',
] as const

courses.patch('/admin/:id', adminMiddleware, zValidator('json', moderateCourseSchema), async (c) => {
  const id = c.req.param('id')
  const body = c.req.valid('json')

  const existing = await prisma.course.findUnique({ where: { id } })
  if (!existing) return c.json({ error: '找不到球場' }, 404)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateData: Record<string, any> = {}
  for (const field of moderatableFields) {
    if (body[field] !== undefined) updateData[field] = body[field]
  }
  if (body.status !== undefined) {
    updateData.status = body.status
    // Stamp the review time when an admin makes a final decision.
    if (body.status === 'approved' || body.status === 'rejected') {
      updateData.reviewedAt = new Date()
    }
  }

  const data = await prisma.course.update({ where: { id }, data: updateData })
  return c.json({ data })
})

courses.delete('/admin/:id', adminMiddleware, async (c) => {
  const id = c.req.param('id')

  const existing = await prisma.course.findUnique({
    where: { id },
    include: { _count: { select: { rounds: true, venues: true } } },
  })
  if (!existing) return c.json({ error: '找不到球場' }, 404)

  // Don't orphan rounds / merchant venues that reference this course.
  if (existing._count.rounds > 0 || existing._count.venues > 0) {
    return c.json({ error: '此球場已有球局或場館關聯，無法刪除' }, 409)
  }

  await prisma.course.delete({ where: { id } })
  return c.json({ ok: true })
})

// ── GET /courses/:id ─── public course detail (approved only) ────────────────────

courses.get('/:id', async (c) => {
  const id = c.req.param('id')

  const data = await prisma.course.findFirst({
    where: { id, status: 'approved' },
    select: publicCourseSelect,
  })
  if (!data) return c.json({ error: '找不到球場' }, 404)

  return c.json({ data })
})

export default courses
