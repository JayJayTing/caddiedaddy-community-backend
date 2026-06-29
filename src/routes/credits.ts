import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { authMiddleware } from '../middleware/auth'
import { confirmPurchase } from '../lib/credits'

const credits = new Hono()

// ── GET /credits/me — wallet balance + recent ledger ────────────────────────────

credits.get('/me', authMiddleware, async (c) => {
  const { sub: userId } = c.get('user')

  const account = await prisma.creditAccount.findUnique({
    where: { userId },
    select: {
      balanceCents: true,
      entries: {
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          type: true,
          deltaCents: true,
          balanceAfterCents: true,
          note: true,
          createdAt: true,
        },
      },
    },
  })

  return c.json({
    data: {
      balanceCents: account?.balanceCents ?? 0,
      entries: account?.entries ?? [],
    },
  })
})

// ── GET /credits/packages — active bulk tiers ───────────────────────────────────

credits.get('/packages', async (c) => {
  const data = await prisma.creditPackage.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: 'asc' }, { priceCents: 'asc' }],
    select: { id: true, name: true, priceCents: true, creditCents: true },
  })
  return c.json({ data })
})

// ── POST /credits/purchase — start a purchase ───────────────────────────────────
// Pilot: CREDITS_AUTOCONFIRM grants immediately so the loop is testable without a
// PSP. Otherwise the purchase stays `pending` until confirmed manually (the
// confirm-purchase script) or, later, by a real PSP webhook calling confirmPurchase.

const purchaseBody = z.object({ packageId: z.string().uuid() })

credits.post('/purchase', authMiddleware, zValidator('json', purchaseBody), async (c) => {
  const { sub: userId } = c.get('user')
  const { packageId } = c.req.valid('json')

  const pkg = await prisma.creditPackage.findFirst({ where: { id: packageId, active: true } })
  if (!pkg) return c.json({ error: '找不到點數方案' }, 404)

  const purchase = await prisma.creditPurchase.create({
    data: {
      userId,
      packageId: pkg.id,
      paidCents: pkg.priceCents,
      creditCents: pkg.creditCents,
      status: 'pending',
      provider: 'manual',
    },
    select: { id: true, status: true },
  })

  if (process.env.CREDITS_AUTOCONFIRM === 'true') {
    const result = await confirmPurchase(purchase.id)
    return c.json(
      { data: { id: purchase.id, status: result.status, balanceCents: result.balanceCents } },
      201,
    )
  }

  return c.json({ data: { id: purchase.id, status: purchase.status } }, 201)
})

export default credits
