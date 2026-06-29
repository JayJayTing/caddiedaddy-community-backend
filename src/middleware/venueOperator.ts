import { createMiddleware } from 'hono/factory'
import { prisma } from '../lib/prisma'
import { verifySupabaseToken, type JwtPayload } from '../lib/supabaseJwt'
import type { VenueOperatorRole } from '@prisma/client'

const RANK: Record<VenueOperatorRole, number> = { staff: 0, manager: 1, owner: 2 }

/**
 * Gate a venue-scoped route on the caller being a VenueOperator of `:venueId`
 * with at least `minRole`. Verifies the Supabase token itself (so it replaces,
 * not stacks on, authMiddleware) and exposes `user` + `venueRole` on the context.
 */
export const requireVenueOperator = (minRole: VenueOperatorRole = 'staff') =>
  createMiddleware<{
    Variables: { user: JwtPayload; venueRole: VenueOperatorRole }
  }>(async (c, next) => {
    const authHeader = c.req.header('Authorization')
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ error: '缺少或無效的授權標頭' }, 401)
    }

    let userId: string
    try {
      const decoded = await verifySupabaseToken(authHeader.slice(7))
      c.set('user', decoded)
      userId = decoded.sub
    } catch {
      return c.json({ error: '權杖無效或已過期' }, 401)
    }

    const venueId = c.req.param('venueId')
    if (!venueId) return c.json({ error: '缺少場地 ID' }, 400)

    const operator = await prisma.venueOperator.findUnique({
      where: { venueId_userId: { venueId, userId } },
    })
    if (!operator) return c.json({ error: '你不是此場地的營運者' }, 403)
    if (RANK[operator.role] < RANK[minRole]) {
      return c.json({ error: '場地權限不足' }, 403)
    }

    c.set('venueRole', operator.role)
    await next()
  })
