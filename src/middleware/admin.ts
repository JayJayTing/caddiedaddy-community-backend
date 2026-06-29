import { createMiddleware } from 'hono/factory'
import { verifySupabaseToken, type JwtPayload } from '../lib/supabaseJwt'

// Platform-admin gate. The app has no global admin role in the DB (only
// community- and venue-scoped roles), so platform admins are configured out of
// band via the ADMIN_USER_IDS env var — a comma-separated list of Supabase user
// UUIDs (the JWT `sub`). Used for course moderation (approve/reject submissions).
const adminUserIds = (): string[] =>
  (process.env.ADMIN_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

export const adminMiddleware = createMiddleware<{
  Variables: { user: JwtPayload }
}>(async (c, next) => {
  const authHeader = c.req.header('Authorization')

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: '缺少或無效的授權標頭' }, 401)
  }

  let decoded: JwtPayload
  try {
    decoded = await verifySupabaseToken(authHeader.slice(7))
  } catch {
    return c.json({ error: '權杖無效或已過期' }, 401)
  }

  if (!adminUserIds().includes(decoded.sub)) {
    return c.json({ error: '需要管理員權限' }, 403)
  }

  c.set('user', decoded)
  await next()
})
