import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { supabaseAdmin } from '../lib/supabase'
import { prisma } from '../lib/prisma'
import { authMiddleware } from '../middleware/auth'

const auth = new Hono()

// POST /auth/verify-otp
const verifyOtpSchema = z.object({
  phone: z.string().min(1),
  token: z.string().min(1),
  type: z.enum(['sms', 'whatsapp']),
})

auth.post('/verify-otp', zValidator('json', verifyOtpSchema), async (c) => {
  const { phone, token, type } = c.req.valid('json')

  const { data, error } = await supabaseAdmin.auth.verifyOtp({
    phone,
    token,
    type,
  })

  if (error) {
    return c.json({ error: error.message }, 400)
  }

  return c.json({ session: data.session, user: data.user })
})

// GET /auth/me — protected
auth.get('/me', authMiddleware, async (c) => {
  const jwtUser = c.get('user')
  const userId = jwtUser.sub

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      displayName: true,
      avatarUrl: true,
      avatarInitial: true,
      bio: true,
      locationText: true,
      handicapIndex: true,
      memberSince: true,
      createdAt: true,
      homeCourse: {
        select: { id: true, name: true, locationText: true },
      },
    },
  })

  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }

  return c.json({ user })
})

export default auth
