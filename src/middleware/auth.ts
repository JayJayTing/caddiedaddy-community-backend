import { createMiddleware } from 'hono/factory'
import { verifySupabaseToken, type JwtPayload } from '../lib/supabaseJwt'

export type { JwtPayload }

export const authMiddleware = createMiddleware<{
  Variables: { user: JwtPayload }
}>(async (c, next) => {
  const authHeader = c.req.header('Authorization')

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401)
  }

  try {
    const decoded = await verifySupabaseToken(authHeader.slice(7))
    c.set('user', decoded)
    await next()
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401)
  }
})
