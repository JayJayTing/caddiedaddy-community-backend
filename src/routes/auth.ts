import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { supabaseAdmin } from '../lib/supabase'
import { prisma } from '../lib/prisma'
import { authMiddleware } from '../middleware/auth'
import { AuthMethod } from '@prisma/client'

const auth = new Hono()

// ── Helper ────────────────────────────────────────────────────────────────────

/**
 * Ensure a User row + UserAuthMethod row exist for the given Supabase user.
 * Safe to call on every login — idempotent.
 */
async function ensureUserExists(
  supabaseUserId: string,
  opts: { displayName: string; method: AuthMethod; credential: string },
) {
  const existing = await prisma.user.findUnique({ where: { id: supabaseUserId } })

  if (!existing) {
    return prisma.user.create({
      data: {
        id: supabaseUserId,
        displayName: opts.displayName,
        authMethods: {
          create: {
            method: opts.method,
            credential: opts.credential,
            verifiedAt: new Date(),
          },
        },
      },
    })
  }

  // Ensure this auth method is linked even if the user already exists
  await prisma.userAuthMethod.upsert({
    where: { method_credential: { method: opts.method, credential: opts.credential } },
    create: {
      userId: supabaseUserId,
      method: opts.method,
      credential: opts.credential,
      verifiedAt: new Date(),
    },
    update: {},
  })

  return existing
}

// ── Phone OTP ─────────────────────────────────────────────────────────────────

/**
 * POST /auth/phone/send-otp
 * Body: { phone, channel? }  — channel defaults to "sms"
 * Sends a 6-digit OTP via SMS (or WhatsApp) using Supabase Auth.
 */
const sendOtpSchema = z.object({
  phone:   z.string().min(1),
  channel: z.enum(['sms', 'whatsapp']).default('sms'),
})

auth.post('/phone/send-otp', zValidator('json', sendOtpSchema), async (c) => {
  const { phone, channel } = c.req.valid('json')

  const { error } = await supabaseAdmin.auth.signInWithOtp({ phone, options: { channel } })
  if (error) return c.json({ error: error.message }, 400)

  return c.json({ ok: true })
})

/**
 * POST /auth/verify-otp
 * Body: { phone, token, type }
 * Verifies OTP, syncs user to DB, returns session.
 */
const verifyOtpSchema = z.object({
  phone: z.string().min(1),
  token: z.string().min(1),
  type:  z.enum(['sms', 'whatsapp']),
})

auth.post('/verify-otp', zValidator('json', verifyOtpSchema), async (c) => {
  const { phone, token, type } = c.req.valid('json')

  const { data, error } = await supabaseAdmin.auth.verifyOtp({ phone, token, type })
  if (error) return c.json({ error: error.message }, 400)
  if (!data.user) return c.json({ error: 'Verification failed' }, 500)

  const user = await ensureUserExists(data.user.id, {
    displayName: phone,
    method: AuthMethod.phone,
    credential: phone,
  })

  return c.json({ session: data.session, user })
})

// ── Email ─────────────────────────────────────────────────────────────────────

/**
 * POST /auth/signup
 * Body: { email, password, displayName }
 * Creates a Supabase user (auto-confirmed) + DB User row, returns session.
 */
const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  displayName: z.string().min(1).max(80),
})

auth.post('/signup', zValidator('json', signupSchema), async (c) => {
  const { email, password, displayName } = c.req.valid('json')

  // Create in Supabase Auth (email_confirm: true skips confirmation email)
  const { data: createData, error: createError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })

  if (createError) return c.json({ error: createError.message }, 400)
  if (!createData.user) return c.json({ error: 'User creation failed' }, 500)

  // Sync to DB
  const user = await ensureUserExists(createData.user.id, {
    displayName,
    method: AuthMethod.email,
    credential: email.toLowerCase(),
  })

  // Sign in to get session tokens
  const { data: sessionData, error: sessionError } = await supabaseAdmin.auth.signInWithPassword({
    email,
    password,
  })
  if (sessionError) return c.json({ error: sessionError.message }, 500)

  return c.json({ session: sessionData.session, user }, 201)
})

/**
 * POST /auth/login
 * Body: { email, password }
 */
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

auth.post('/login', zValidator('json', loginSchema), async (c) => {
  const { email, password } = c.req.valid('json')

  const { data, error } = await supabaseAdmin.auth.signInWithPassword({ email, password })
  if (error) return c.json({ error: error.message }, 401)

  const user = await prisma.user.findUnique({ where: { id: data.user.id } })

  return c.json({ session: data.session, user })
})

/**
 * POST /auth/logout
 * Requires Bearer token. Invalidates the session server-side.
 */
auth.post('/logout', authMiddleware, async (c) => {
  const token = c.req.header('Authorization')!.slice(7)

  const { error } = await supabaseAdmin.auth.admin.signOut(token)
  if (error) return c.json({ error: error.message }, 400)

  return c.json({ ok: true })
})

// ── Google OAuth ──────────────────────────────────────────────────────────────

/**
 * GET /auth/google/url?redirectTo=<your-frontend-callback-url>
 *
 * Returns the Google OAuth URL. Flow:
 *   1. Client calls this endpoint → gets { url }
 *   2. Client redirects user to url
 *   3. Google → Supabase → redirects back to redirectTo with ?code=xxx
 *   4. Client sends POST /auth/google/callback with { code }
 */
auth.get('/google/url', async (c) => {
  const redirectTo = c.req.query('redirectTo')
  if (!redirectTo) return c.json({ error: 'redirectTo query param is required' }, 400)

  const { data, error } = await supabaseAdmin.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo, skipBrowserRedirect: true },
  })

  if (error) return c.json({ error: error.message }, 500)

  return c.json({ url: data.url })
})

/**
 * POST /auth/google/callback
 * Body: { code }  — the ?code= value from the OAuth redirect
 *
 * Exchanges code for session, syncs user to DB, returns session.
 */
const googleCallbackSchema = z.object({
  code: z.string().min(1),
})

auth.post('/google/callback', zValidator('json', googleCallbackSchema), async (c) => {
  const { code } = c.req.valid('json')

  const { data, error } = await supabaseAdmin.auth.exchangeCodeForSession(code)
  if (error) return c.json({ error: error.message }, 400)
  if (!data.user) return c.json({ error: 'No user returned from Google' }, 500)

  const supabaseUser = data.user
  const googleId =
    (supabaseUser.user_metadata?.provider_id as string | undefined) ?? supabaseUser.id
  const displayName =
    (supabaseUser.user_metadata?.full_name as string | undefined) ??
    (supabaseUser.user_metadata?.name as string | undefined) ??
    supabaseUser.email?.split('@')[0] ??
    'User'

  const user = await ensureUserExists(supabaseUser.id, {
    displayName,
    method: AuthMethod.google,
    credential: googleId,
  })

  return c.json({ session: data.session, user })
})

// ── Me ────────────────────────────────────────────────────────────────────────

/**
 * GET /auth/me — protected
 * Returns the current user's DB profile.
 */
auth.get('/me', authMiddleware, async (c) => {
  const jwtUser = c.get('user')

  const user = await prisma.user.findUnique({
    where: { id: jwtUser.sub },
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

  if (!user) return c.json({ error: 'User not found' }, 404)

  return c.json({ user })
})

export default auth
