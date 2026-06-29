import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { authMiddleware } from '../middleware/auth'
import { spendCredits, commissionForCents } from '../lib/credits'

const venues = new Hono()

// ── Shared selects / helpers ────────────────────────────────────────────────────

const venueCardSelect = {
  id: true,
  name: true,
  type: true,
  locationText: true,
  district: true,
  city: true,
  lat: true,
  lng: true,
  coverUrl: true,
  paymentMode: true,
} as const

// Stored @db.Time() values are timezone-naive on the epoch date → "HH:MM".
function timeLabel(t: Date): string {
  return t.toISOString().slice(11, 16)
}

// ── GET /venues — browse active venues ──────────────────────────────────────────

const listQuery = z.object({
  city: z.string().optional(),
  type: z.enum(['course', 'driving_range']).optional(),
  q: z.string().optional(),
})

venues.get('/', zValidator('query', listQuery), async (c) => {
  const { city, type, q } = c.req.valid('query')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = { status: 'active', deletedAt: null }
  if (city) where.city = city
  if (type) where.type = type
  if (q) where.name = { contains: q, mode: 'insensitive' }

  const data = await prisma.venue.findMany({
    where,
    select: venueCardSelect,
    orderBy: { name: 'asc' },
    take: 50,
  })

  return c.json({ data })
})

// ── GET /venues/:id — public detail + booking policy ────────────────────────────

venues.get('/:id', async (c) => {
  const id = c.req.param('id')

  const data = await prisma.venue.findFirst({
    where: { id, status: 'active', deletedAt: null },
    select: {
      ...venueCardSelect,
      description: true,
      phone: true,
      country: true,
      minPartySize: true,
      maxPartySize: true,
      advanceBookingDays: true,
      cancellationCutoffHours: true,
      depositCents: true,
      course: { select: { id: true, name: true, holeCount: true } },
    },
  })

  if (!data) return c.json({ error: '找不到場地' }, 404)
  return c.json({ data })
})

// ── GET /venues/:id/slots?date=YYYY-MM-DD — bookable availability for a day ──────

const slotsQuery = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})

venues.get('/:id/slots', zValidator('query', slotsQuery), async (c) => {
  const id = c.req.param('id')
  const { date } = c.req.valid('query')

  // Closed date → no bookable times, even if stray slots linger.
  const closed = await prisma.availabilityException.findFirst({
    where: { venueId: id, date: new Date(date), type: 'closed' },
    select: { id: true },
  })
  if (closed) return c.json({ data: [] })

  const slots = await prisma.bookingSlot.findMany({
    where: { venueId: id, date: new Date(date), status: 'open' },
    select: {
      id: true,
      startTime: true,
      holes: true,
      capacity: true,
      bookedCount: true,
      priceCents: true,
      creditPriceCents: true,
    },
    orderBy: { startTime: 'asc' },
  })

  const data = slots
    .map((s) => ({
      id: s.id,
      time: timeLabel(s.startTime),
      holes: s.holes,
      capacity: s.capacity,
      remaining: s.capacity - s.bookedCount,
      priceCents: s.priceCents,
      creditPriceCents: s.creditPriceCents,
    }))
    .filter((s) => s.remaining > 0)

  return c.json({ data })
})

// ── POST /venues/:id/slots/:slotId/book — reserve, oversell-safe ─────────────────

const bookBody = z.object({
  partySize: z.number().int().min(1).max(8).default(1),
  notes: z.string().max(500).optional(),
  payWithCredits: z.boolean().optional().default(false),
})

const bookingInclude = {
  slot: { select: { date: true, startTime: true, holes: true } },
  venue: { select: { name: true, locationText: true, paymentMode: true } },
} as const

venues.post(
  '/:id/slots/:slotId/book',
  authMiddleware,
  zValidator('json', bookBody),
  async (c) => {
    const { sub: userId } = c.get('user')
    const slotId = c.req.param('slotId')
    const { partySize, notes, payWithCredits } = c.req.valid('json')

    const booking = await prisma.$transaction(async (tx) => {
      // Conditional UPDATE locks the row and guards capacity in one statement.
      // If the slot is full, blocked, or gone, 0 rows update → reject. The row
      // lock held until COMMIT means concurrent bookers can't both win the last spot.
      const claimed = await tx.$executeRaw`
        UPDATE booking_slots
           SET booked_count = booked_count + ${partySize}, updated_at = now()
         WHERE id = ${slotId}::uuid
           AND status = 'open'
           AND booked_count + ${partySize} <= capacity
      `
      if (claimed === 0) {
        throw new HTTPException(409, { message: '此時段已無法預約' })
      }

      const slot = await tx.bookingSlot.findUniqueOrThrow({
        where: { id: slotId },
        include: { venue: { select: { commissionBps: true } } },
      })

      // ── Credit booking (prepaid via wallet, discounted "deal" price) ──────────
      if (payWithCredits) {
        if (slot.creditPriceCents == null) {
          throw new HTTPException(400, { message: '此時段不支援點數折扣' })
        }
        const unit = slot.creditPriceCents
        const total = unit * partySize

        const created = await tx.booking.create({
          data: {
            venueId: slot.venueId,
            slotId: slot.id,
            userId,
            partySize,
            unitPriceCents: unit,
            totalCents: total,
            creditCents: total,
            status: 'confirmed',
            paymentStatus: 'paid', // prepaid with credits
            notes,
          },
          include: bookingInclude,
        })

        // Deduct credits, oversell-safe. A shortfall throws 409 and rolls back
        // the slot claim + booking created above.
        await spendCredits(tx, userId, total, created.id)

        // Record what the platform owes the merchant (commission held back).
        const commission = commissionForCents(total, slot.venue.commissionBps)
        await tx.settlementItem.create({
          data: {
            venueId: slot.venueId,
            bookingId: created.id,
            grossCents: total,
            commissionCents: commission,
            netCents: total - commission,
            status: 'accrued',
          },
        })

        return created
      }

      // ── Cash booking (pay at venue) — unchanged behaviour ─────────────────────
      return tx.booking.create({
        data: {
          venueId: slot.venueId,
          slotId: slot.id,
          userId,
          partySize,
          unitPriceCents: slot.priceCents,
          totalCents: slot.priceCents * partySize,
          status: 'confirmed',
          paymentStatus: 'none', // pay at venue
          notes,
        },
        include: bookingInclude,
      })
    })

    return c.json({ data: booking }, 201)
  },
)

export default venues
