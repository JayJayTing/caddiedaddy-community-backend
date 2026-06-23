import { createMiddleware } from 'hono/factory'
import { verify } from 'hono/jwt'

export type JwtPayload = {
  sub: string
  email?: string
  phone?: string
  role?: string
  iat?: number
  exp?: number
  [key: string]: unknown
}

export const authMiddleware = createMiddleware<{
  Variables: { user: JwtPayload }
}>(async (c, next) => {
  const authHeader = c.req.header('Authorization')

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401)
  }

  const token = authHeader.slice(7)
  const secret = process.env.SUPABASE_JWT_SECRET

  if (!secret) {
    console.error('SUPABASE_JWT_SECRET env var not set')
    return c.json({ error: 'Server configuration error' }, 500)
  }

  try {
    const decoded = await verify(token, secret, 'HS256') as JwtPayload
    c.set('user', decoded)
    await next()
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401)
  }
})
