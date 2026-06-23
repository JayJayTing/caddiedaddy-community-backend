import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../lib/prisma'

const courses = new Hono()

// ── GET /courses ───────────────────────────────────────────────────────────────

const searchQuerySchema = z.object({
  q: z.string().min(2),
})

courses.get('/', zValidator('query', searchQuerySchema), async (c) => {
  const { q } = c.req.valid('query')

  const data = await prisma.course.findMany({
    where: {
      name: { contains: q, mode: 'insensitive' },
    },
    select: {
      id: true,
      name: true,
      locationText: true,
      district: true,
      city: true,
      holeCount: true,
    },
    take: 10,
  })

  return c.json({ data })
})

export default courses
