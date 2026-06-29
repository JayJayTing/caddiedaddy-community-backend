import { Hono } from 'hono'
import { verify } from 'hono/jwt'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { supabaseAdmin } from '../lib/supabase'
import { prisma } from '../lib/prisma'
import { authMiddleware } from '../middleware/auth'
import { AuthMethod } from '@prisma/client'

const auth = new Hono()

// Gate email verification so the new flow can ship inert and be switched on only
// once the Supabase email OTP template + SMTP are configured. Default: off
// (instant signup, matching prior behaviour).
const ENFORCE_EMAIL_VERIFICATION = process.env.ENFORCE_EMAIL_VERIFICATION === 'true'

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

// Shape of the signed-in user's own profile, shared by /auth/me and /auth/oauth/sync.
const meSelect = {
  id: true,
  displayName: true,
  avatarUrl: true,
  avatarInitial: true,
  bio: true,
  locationText: true,
  handicapIndex: true,
  memberSince: true,
  createdAt: true,
  homeCourse: { select: { id: true, name: true, locationText: true } },
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
  if (!data.user) return c.json({ error: '驗證失敗' }, 500)

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
  password: z.string().min(8, '密碼至少需要 8 個字元'),
  displayName: z.string().min(1).max(80),
})

auth.post('/signup', zValidator('json', signupSchema), async (c) => {
  const { email, password, displayName } = c.req.valid('json')

  if (!ENFORCE_EMAIL_VERIFICATION) {
    // Instant signup (auto-confirmed). Flip ENFORCE_EMAIL_VERIFICATION=true once the
    // Supabase email OTP template + SMTP are ready to require verification instead.
    const { data: createData, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: displayName },
    })
    if (createError) return c.json({ error: '此電子郵件已被註冊，請改用登入或重設密碼。' }, 409)
    if (!createData.user) return c.json({ error: '建立使用者失敗' }, 500)

    const user = await ensureUserExists(createData.user.id, {
      displayName,
      method: AuthMethod.email,
      credential: email.toLowerCase(),
    })
    const { data: sessionData, error: sessionError } =
      await supabaseAdmin.auth.signInWithPassword({ email, password })
    if (sessionError || !sessionData.session) {
      return c.json({ error: sessionError?.message ?? '建立使用者失敗' }, 500)
    }
    return c.json({ session: sessionData.session, user }, 201)
  }

  // Verified signup: create the user UNCONFIRMED with the password set; stash the
  // display name so the profile can be built after verification. The account can't
  // be used (or transact) until the emailed 6-digit code is confirmed.
  const { data: createData, error: createError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: false,
    user_metadata: { display_name: displayName },
  })
  if (createError) return c.json({ error: '此電子郵件已被註冊，請改用登入或重設密碼。' }, 409)
  if (!createData.user) return c.json({ error: '建立使用者失敗' }, 500)

  const { error: otpError } = await supabaseAdmin.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false },
  })
  if (otpError) return c.json({ error: otpError.message }, 400)

  return c.json({ pendingVerification: true }, 201)
})

/**
 * POST /auth/verify-email
 * Body: { email, token } — the 6-digit code emailed at signup.
 * Confirms the email, syncs the DB user, returns a session.
 */
const verifyEmailSchema = z.object({ email: z.string().email(), token: z.string().min(1) })

auth.post('/verify-email', zValidator('json', verifyEmailSchema), async (c) => {
  const { email, token } = c.req.valid('json')

  const { data, error } = await supabaseAdmin.auth.verifyOtp({ email, token, type: 'email' })
  if (error) return c.json({ error: error.message }, 400)
  if (!data.user || !data.session) return c.json({ error: '驗證失敗' }, 400)

  const displayName =
    (data.user.user_metadata?.display_name as string | undefined) ?? email.split('@')[0]
  const user = await ensureUserExists(data.user.id, {
    displayName,
    method: AuthMethod.email,
    credential: email.toLowerCase(),
  })

  return c.json({ session: data.session, user })
})

/**
 * POST /auth/email/resend-otp
 * Body: { email } — re-sends the email verification code.
 */
const emailResendSchema = z.object({ email: z.string().email() })

auth.post('/email/resend-otp', zValidator('json', emailResendSchema), async (c) => {
  const { email } = c.req.valid('json')
  const { error } = await supabaseAdmin.auth.signInWithOtp({ email, options: { shouldCreateUser: false } })
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ ok: true })
})

// ── Password reset ──────────────────────────────────────────────────────────────

/**
 * POST /auth/password/forgot
 * Body: { email } — emails a 6-digit code to reset the password. Always returns ok
 * (never reveals whether the account exists, to avoid account enumeration). The
 * client verifies the code via /auth/verify-email (which establishes a session),
 * then calls /auth/password/update.
 */
auth.post('/password/forgot', zValidator('json', emailResendSchema), async (c) => {
  const { email } = c.req.valid('json')
  await supabaseAdmin.auth.signInWithOtp({ email, options: { shouldCreateUser: false } })
  return c.json({ ok: true })
})

/**
 * POST /auth/password/update — protected (Bearer)
 * Body: { password } — sets a new password for the signed-in user.
 */
const updatePasswordSchema = z.object({ password: z.string().min(8, '密碼至少需要 8 個字元') })

auth.post('/password/update', authMiddleware, zValidator('json', updatePasswordSchema), async (c) => {
  const jwtUser = c.get('user')
  const { password } = c.req.valid('json')
  const { error } = await supabaseAdmin.auth.admin.updateUserById(jwtUser.sub, { password })
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ ok: true })
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
  if (error) {
    // Unverified email → tell the client to route to the email-verification step.
    if (/confirm/i.test(error.message)) {
      return c.json({ error: '請先完成電子郵件驗證。', needsVerification: true }, 403)
    }
    return c.json({ error: error.message }, 401)
  }

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

// ── Session refresh ─────────────────────────────────────────────────────────────

/**
 * POST /auth/refresh
 * Body: { refreshToken }
 * Exchanges a refresh token for a fresh session (new access token + rotated
 * refresh token). The frontend calls this automatically when a request 401s, so
 * users aren't logged out every time the ~1h access token expires (critical
 * during a checkout/payment flow). The refresh token is passed explicitly, so
 * this is safe to run on the stateless shared admin client.
 */
const refreshSchema = z.object({ refreshToken: z.string().min(1) })

auth.post('/refresh', zValidator('json', refreshSchema), async (c) => {
  const { refreshToken } = c.req.valid('json')

  const { data, error } = await supabaseAdmin.auth.refreshSession({ refresh_token: refreshToken })
  if (error || !data.session) {
    return c.json({ error: error?.message ?? '工作階段已過期，請重新登入' }, 401)
  }

  return c.json({ session: data.session })
})

// ── OAuth sync (Google / Apple) ─────────────────────────────────────────────────

/**
 * POST /auth/oauth/sync — protected (Bearer access token)
 *
 * The browser completes the OAuth + PKCE exchange directly with Supabase, so the
 * per-user code-verifier lives in the browser rather than a shared server
 * singleton (the previous backend exchange raced under concurrency and broke on
 * multi-instance deploys). The client then calls this with its fresh access
 * token; we read the verified Supabase user, ensure the DB User + auth-method
 * link exist, and return the app profile (same shape as /auth/me).
 */
auth.post('/oauth/sync', authMiddleware, async (c) => {
  const jwtUser = c.get('user')

  const { data, error } = await supabaseAdmin.auth.admin.getUserById(jwtUser.sub)
  if (error || !data.user) return c.json({ error: '找不到使用者' }, 404)

  const su = data.user
  const provider = (su.app_metadata?.provider as string | undefined) ?? 'email'
  const method =
    provider === 'google' ? AuthMethod.google
    : provider === 'apple' ? AuthMethod.apple
    : provider === 'phone' ? AuthMethod.phone
    : AuthMethod.email
  const credential =
    (su.identities?.[0]?.id as string | undefined)
    ?? (su.user_metadata?.provider_id as string | undefined)
    ?? su.email ?? su.phone ?? su.id
  const displayName =
    (su.user_metadata?.full_name as string | undefined)
    ?? (su.user_metadata?.name as string | undefined)
    ?? su.email?.split('@')[0] ?? su.phone ?? 'User'

  await ensureUserExists(su.id, { displayName, method, credential })

  const user = await prisma.user.findUnique({ where: { id: su.id }, select: meSelect })
  return c.json({ user })
})

// ── LINE Login ──────────────────────────────────────────────────────────────────

const LINE_CHANNEL_ID = process.env.LINE_CHANNEL_ID
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET

type LineIdToken = {
  iss?: string
  aud?: string | string[]
  sub?: string
  nonce?: string
  name?: string
  picture?: string
  email?: string
}

// LINE signs id_tokens with the channel secret (HS256). verify() also checks exp.
async function verifyLineIdToken(idToken: string, nonce: string): Promise<LineIdToken> {
  if (!LINE_CHANNEL_SECRET || !LINE_CHANNEL_ID) throw new Error('LINE not configured')
  const payload = (await verify(idToken, LINE_CHANNEL_SECRET, 'HS256')) as LineIdToken
  const audOk = Array.isArray(payload.aud)
    ? payload.aud.includes(LINE_CHANNEL_ID)
    : payload.aud === LINE_CHANNEL_ID
  if (payload.iss !== 'https://access.line.me') throw new Error('bad iss')
  if (!audOk) throw new Error('bad aud')
  if (payload.nonce !== nonce) throw new Error('bad nonce')
  if (!payload.sub) throw new Error('no sub')
  return payload
}

/**
 * POST /auth/line/callback
 * Body: { code, redirectUri, nonce }
 *
 * LINE isn't a native Supabase provider, so we run the OAuth dance ourselves:
 * exchange the code → verify the id_token (HS256 channel secret + iss/aud/nonce)
 * → map the LINE user id to a Supabase user (our DB is the mapping source of
 * truth) → mint a Supabase session via an admin magic-link (no password needed).
 */
const lineCallbackSchema = z.object({
  code: z.string().min(1),
  redirectUri: z.string().url(),
  nonce: z.string().min(1),
})

auth.post('/line/callback', zValidator('json', lineCallbackSchema), async (c) => {
  const { code, redirectUri, nonce } = c.req.valid('json')
  if (!LINE_CHANNEL_ID || !LINE_CHANNEL_SECRET) return c.json({ error: 'LINE 登入尚未設定' }, 500)

  // 1. Exchange the authorization code for tokens.
  const tokenRes = await fetch('https://api.line.me/oauth2/v2.1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: LINE_CHANNEL_ID,
      client_secret: LINE_CHANNEL_SECRET,
    }),
  })
  if (!tokenRes.ok) return c.json({ error: 'LINE 授權失敗，請再試一次。' }, 400)
  const tokenJson = (await tokenRes.json()) as { id_token?: string }
  if (!tokenJson.id_token) return c.json({ error: 'LINE 未回傳身分權杖' }, 400)

  // 2. Verify the id_token + claims.
  let claims: LineIdToken
  try {
    claims = await verifyLineIdToken(tokenJson.id_token, nonce)
  } catch {
    return c.json({ error: 'LINE 身分驗證失敗' }, 401)
  }
  const lineUserId = claims.sub as string
  const displayName = claims.name ?? 'LINE 使用者'

  // 3. Map the LINE user id → our user (our DB is the mapping source of truth).
  const existing = await prisma.userAuthMethod.findUnique({
    where: { method_credential: { method: AuthMethod.line, credential: lineUserId } },
    select: { userId: true },
  })

  let supabaseUserId: string
  let userEmail: string

  if (existing) {
    supabaseUserId = existing.userId
    const { data } = await supabaseAdmin.auth.admin.getUserById(supabaseUserId)
    userEmail = data.user?.email ?? `line_${lineUserId}@line.caddiedaddy.app`
  } else {
    userEmail = claims.email ?? `line_${lineUserId}@line.caddiedaddy.app`
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: userEmail,
      email_confirm: true,
      user_metadata: { full_name: displayName, line_user_id: lineUserId, provider: 'line' },
    })
    if (createErr || !created.user) {
      return c.json({ error: '此 LINE 帳號的電子郵件已被其他帳號使用。' }, 409)
    }
    supabaseUserId = created.user.id
  }

  await ensureUserExists(supabaseUserId, {
    displayName,
    method: AuthMethod.line,
    credential: lineUserId,
  })

  // 4. Mint a Supabase session without a password (admin magic-link → verify).
  const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email: userEmail,
  })
  const tokenHash = linkData?.properties?.hashed_token
  if (linkErr || !tokenHash) return c.json({ error: '建立工作階段失敗' }, 500)

  const { data: verifyData, error: verifyErr } = await supabaseAdmin.auth.verifyOtp({
    type: 'magiclink',
    token_hash: tokenHash,
  })
  if (verifyErr || !verifyData.session) return c.json({ error: '建立工作階段失敗' }, 500)

  const user = await prisma.user.findUnique({ where: { id: supabaseUserId }, select: meSelect })
  return c.json({ session: verifyData.session, user })
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
    select: meSelect,
  })

  if (!user) return c.json({ error: '找不到使用者' }, 404)

  return c.json({ user })
})

export default auth
