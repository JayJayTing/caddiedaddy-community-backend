import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { authMiddleware } from '../middleware/auth'
import { requireVenueOperator } from '../middleware/venueOperator'
import { generateSlots, regenerateFuture, addManualSlot } from '../lib/slots'
import { grantCredits } from '../lib/credits'

const merchant = new Hono()

// ════════════════════════════════════════════════════════════════════════════
//  Venue ownership
// ════════════════════════════════════════════════════════════════════════════

// ── GET /merchant/venues — venues the current user operates ─────────────────────

merchant.get('/venues', authMiddleware, async (c) => {
  const { sub: userId } = c.get('user')

  const data = await prisma.venue.findMany({
    where: { deletedAt: null, operators: { some: { userId } } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      type: true,
      status: true,
      locationText: true,
      city: true,
      paymentMode: true,
      operators: { where: { userId }, select: { role: true } },
      _count: { select: { bookings: true, slots: true } },
    },
  })

  // Flatten the caller's role onto each venue.
  const shaped = data.map(({ operators, ...v }) => ({ ...v, myRole: operators[0]?.role ?? null }))
  return c.json({ data: shaped })
})

// ── POST /merchant/venues — apply to list a venue (starts pending) ──────────────

const createVenue = z.object({
  name: z.string().min(2).max(100),
  type: z.enum(['course', 'driving_range']),
  locationText: z.string().max(120).optional(),
  district: z.string().max(40).optional(),
  city: z.string().max(40).optional(),
  phone: z.string().max(40).optional(),
  description: z.string().max(2000).optional(),
  courseId: z.string().uuid().optional(),
})

merchant.post('/venues', authMiddleware, zValidator('json', createVenue), async (c) => {
  const { sub: userId } = c.get('user')
  const body = c.req.valid('json')

  // New venues start `pending`; a platform admin flips them to `active` once
  // vetted (handled out-of-band via Supabase Studio in the pilot phase).
  const data = await prisma.venue.create({
    data: {
      ...body,
      status: 'pending',
      operators: { create: { userId, role: 'owner' } },
    },
    select: { id: true, name: true, status: true, type: true },
  })

  return c.json({ data }, 201)
})

// ── GET /merchant/venues/:venueId — full management detail ──────────────────────

merchant.get('/venues/:venueId', requireVenueOperator(), async (c) => {
  const venueId = c.req.param('venueId')

  const data = await prisma.venue.findUnique({
    where: { id: venueId },
    include: {
      operators: {
        select: { userId: true, role: true, user: { select: { displayName: true, avatarUrl: true } } },
      },
      _count: { select: { bookings: true, slots: true, availabilityRules: true } },
    },
  })

  return c.json({ data, myRole: c.get('venueRole') })
})

// ── PATCH /merchant/venues/:venueId — edit info + booking policy ─────────────────

const patchVenue = z.object({
  name: z.string().min(2).max(100).optional(),
  locationText: z.string().max(120).nullable().optional(),
  district: z.string().max(40).nullable().optional(),
  city: z.string().max(40).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  coverUrl: z.string().url().nullable().optional(),
  paymentMode: z.enum(['pay_at_venue', 'deposit', 'prepaid']).optional(),
  depositCents: z.number().int().nonnegative().nullable().optional(),
  minPartySize: z.number().int().min(1).max(8).optional(),
  maxPartySize: z.number().int().min(1).max(8).optional(),
  advanceBookingDays: z.number().int().min(1).max(365).optional(),
  cancellationCutoffHours: z.number().int().min(0).max(168).optional(),
})

merchant.patch(
  '/venues/:venueId',
  requireVenueOperator('manager'),
  zValidator('json', patchVenue),
  async (c) => {
    const venueId = c.req.param('venueId')
    const body = c.req.valid('json')

    const data = await prisma.venue.update({
      where: { id: venueId },
      data: body,
      select: { id: true, name: true, status: true, paymentMode: true },
    })

    return c.json({ data })
  },
)

// ── GET /merchant/venues/:venueId/stats — bookings + earnings (day/month/year) ──
// "Earned" = what the venue keeps: cash (pay-at-venue) bookings at full price +
// credit bookings at the net owed (gross − commission). Cancelled bookings and
// voided settlements are excluded. Periods are anchored on the tee-time date.

merchant.get('/venues/:venueId/stats', requireVenueOperator(), async (c) => {
  const venueId = c.req.param('venueId')

  const now = new Date()
  const y = now.getUTCFullYear()
  const mo = now.getUTCMonth()
  const da = now.getUTCDate()
  const periods = {
    day: [new Date(Date.UTC(y, mo, da)), new Date(Date.UTC(y, mo, da + 1))],
    month: [new Date(Date.UTC(y, mo, 1)), new Date(Date.UTC(y, mo + 1, 1))],
    year: [new Date(Date.UTC(y, 0, 1)), new Date(Date.UTC(y + 1, 0, 1))],
  } as const

  async function period(gte: Date, lt: Date) {
    const [cash, credit] = await Promise.all([
      // Pay-at-venue (non-credit) bookings — venue collects the full price.
      prisma.booking.aggregate({
        where: { venueId, status: { not: 'cancelled' }, creditCents: 0, slot: { date: { gte, lt } } },
        _count: { _all: true },
        _sum: { totalCents: true },
      }),
      // Credit bookings — venue is owed the net (gross − commission).
      prisma.settlementItem.aggregate({
        where: { venueId, status: { not: 'voided' }, booking: { status: { not: 'cancelled' }, slot: { date: { gte, lt } } } },
        _count: { _all: true },
        _sum: { netCents: true, grossCents: true },
      }),
    ])
    const cashTotal = cash._sum.totalCents ?? 0
    return {
      bookings: cash._count._all + credit._count._all,
      creditBookings: credit._count._all,
      earnedCents: cashTotal + (credit._sum.netCents ?? 0),
      grossCents: cashTotal + (credit._sum.grossCents ?? 0),
    }
  }

  const [day, month, year] = await Promise.all([
    period(periods.day[0], periods.day[1]),
    period(periods.month[0], periods.month[1]),
    period(periods.year[0], periods.year[1]),
  ])

  return c.json({ data: { day, month, year } })
})

// ════════════════════════════════════════════════════════════════════════════
//  Availability rules
// ════════════════════════════════════════════════════════════════════════════

merchant.get('/venues/:venueId/availability-rules', requireVenueOperator(), async (c) => {
  const venueId = c.req.param('venueId')
  const data = await prisma.availabilityRule.findMany({
    where: { venueId },
    orderBy: [{ active: 'desc' }, { startMinute: 'asc' }],
  })
  return c.json({ data })
})

const ruleBody = z.object({
  label: z.string().max(60).optional(),
  weekdayMask: z.number().int().min(0).max(127),
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(0).max(1439),
  intervalMin: z.number().int().min(5).max(240).default(10),
  holes: z.number().int().refine((n) => n === 9 || n === 18).nullable().optional(),
  capacity: z.number().int().min(1).max(64).default(4),
  priceCents: z.number().int().nonnegative(),
  creditPriceCents: z.number().int().nonnegative().nullable().optional(),
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
}).refine((r) => r.endMinute >= r.startMinute, {
  message: '結束時間必須大於或等於開始時間',
})

merchant.post(
  '/venues/:venueId/availability-rules',
  requireVenueOperator('manager'),
  zValidator('json', ruleBody),
  async (c) => {
    const venueId = c.req.param('venueId')
    const body = c.req.valid('json')

    const data = await prisma.availabilityRule.create({
      data: {
        venueId,
        label: body.label,
        weekdayMask: body.weekdayMask,
        startMinute: body.startMinute,
        endMinute: body.endMinute,
        intervalMin: body.intervalMin,
        holes: body.holes ?? null,
        capacity: body.capacity,
        priceCents: body.priceCents,
        creditPriceCents: body.creditPriceCents ?? null,
        validFrom: body.validFrom ? new Date(body.validFrom) : null,
        validTo: body.validTo ? new Date(body.validTo) : null,
      },
    })

    // Reflect the new block in the bookable horizon immediately.
    await regenerateFuture(venueId)
    return c.json({ data }, 201)
  },
)

const patchRule = z.object({
  label: z.string().max(60).nullable().optional(),
  weekdayMask: z.number().int().min(0).max(127).optional(),
  startMinute: z.number().int().min(0).max(1439).optional(),
  endMinute: z.number().int().min(0).max(1439).optional(),
  intervalMin: z.number().int().min(5).max(240).optional(),
  holes: z.number().int().refine((n) => n === 9 || n === 18).nullable().optional(),
  capacity: z.number().int().min(1).max(64).optional(),
  priceCents: z.number().int().nonnegative().optional(),
  creditPriceCents: z.number().int().nonnegative().nullable().optional(),
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  active: z.boolean().optional(),
})

merchant.patch(
  '/venues/:venueId/availability-rules/:ruleId',
  requireVenueOperator('manager'),
  zValidator('json', patchRule),
  async (c) => {
    const venueId = c.req.param('venueId')
    const ruleId = c.req.param('ruleId')
    const body = c.req.valid('json')

    const rule = await prisma.availabilityRule.findFirst({ where: { id: ruleId, venueId } })
    if (!rule) return c.json({ error: '找不到規則' }, 404)

    // Convert the date strings; pass the rest through.
    const { validFrom, validTo, ...rest } = body
    const data = await prisma.availabilityRule.update({
      where: { id: ruleId },
      data: {
        ...rest,
        ...(validFrom !== undefined ? { validFrom: validFrom ? new Date(validFrom) : null } : {}),
        ...(validTo !== undefined ? { validTo: validTo ? new Date(validTo) : null } : {}),
      },
    })

    // Apply the edit to future open, unbooked slots.
    await regenerateFuture(venueId)
    return c.json({ data })
  },
)

merchant.delete(
  '/venues/:venueId/availability-rules/:ruleId',
  requireVenueOperator('manager'),
  async (c) => {
    const venueId = c.req.param('venueId')
    const ruleId = c.req.param('ruleId')

    const rule = await prisma.availabilityRule.findFirst({ where: { id: ruleId, venueId } })
    if (!rule) return c.json({ error: '找不到規則' }, 404)

    // Deactivate rather than hard-delete so existing generated slots keep their FK.
    await prisma.availabilityRule.update({ where: { id: ruleId }, data: { active: false } })
    // Drop this rule's future open, unbooked slots (regen rebuilds from active rules only).
    await regenerateFuture(venueId)
    return c.json({ ok: true })
  },
)

// ════════════════════════════════════════════════════════════════════════════
//  Slots — generate, list, block / re-price
// ════════════════════════════════════════════════════════════════════════════

const generateBody = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})

merchant.post(
  '/venues/:venueId/slots/generate',
  requireVenueOperator('manager'),
  zValidator('json', generateBody),
  async (c) => {
    const venueId = c.req.param('venueId')
    const { from, to } = c.req.valid('json')

    const fromDate = new Date(from)
    const toDate = new Date(to)
    const days = (toDate.getTime() - fromDate.getTime()) / 86_400_000
    if (days < 0) return c.json({ error: '`to` 必須等於或晚於 `from`' }, 400)
    if (days > 92) return c.json({ error: '範圍過大，每次最多只能產生 92 天' }, 400)

    const created = await generateSlots(venueId, fromDate, toDate)
    return c.json({ created })
  },
)

merchant.get(
  '/venues/:venueId/slots',
  requireVenueOperator(),
  zValidator('query', z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })),
  async (c) => {
    const venueId = c.req.param('venueId')
    const { date } = c.req.valid('query')

    const data = await prisma.bookingSlot.findMany({
      where: { venueId, date: new Date(date) },
      orderBy: { startTime: 'asc' },
      select: {
        id: true,
        startTime: true,
        holes: true,
        capacity: true,
        bookedCount: true,
        priceCents: true,
        creditPriceCents: true,
        status: true,
        source: true,
      },
    })
    return c.json({ data })
  },
)

// ── POST /venues/:venueId/slots — add a single one-off slot (manual) ─────────────

const manualSlotBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startMinute: z.number().int().min(0).max(1439),
  holes: z.number().int().refine((n) => n === 9 || n === 18).nullable().optional(),
  capacity: z.number().int().min(1).max(64),
  priceCents: z.number().int().nonnegative(),
  creditPriceCents: z.number().int().nonnegative().nullable().optional(),
})

merchant.post(
  '/venues/:venueId/slots',
  requireVenueOperator('manager'),
  zValidator('json', manualSlotBody),
  async (c) => {
    const venueId = c.req.param('venueId')
    const body = c.req.valid('json')
    try {
      const data = await addManualSlot(venueId, {
        date: new Date(body.date),
        startMinute: body.startMinute,
        holes: body.holes ?? null,
        capacity: body.capacity,
        priceCents: body.priceCents,
        creditPriceCents: body.creditPriceCents ?? null,
      })
      return c.json({ data }, 201)
    } catch {
      // Unique (venueId, date, startTime, holes) collision → a slot already exists.
      return c.json({ error: '此時段已存在' }, 409)
    }
  },
)

const patchSlot = z.object({
  status: z.enum(['open', 'blocked']).optional(),
  priceCents: z.number().int().nonnegative().optional(),
  creditPriceCents: z.number().int().nonnegative().nullable().optional(),
  capacity: z.number().int().min(1).max(64).optional(),
})

merchant.patch(
  '/venues/:venueId/slots/:slotId',
  requireVenueOperator('manager'),
  zValidator('json', patchSlot),
  async (c) => {
    const venueId = c.req.param('venueId')
    const slotId = c.req.param('slotId')
    const body = c.req.valid('json')

    const slot = await prisma.bookingSlot.findFirst({ where: { id: slotId, venueId } })
    if (!slot) return c.json({ error: '找不到時段' }, 404)
    if (body.capacity !== undefined && body.capacity < slot.bookedCount) {
      return c.json({ error: `容量不可低於已預約的 ${slot.bookedCount} 個名額` }, 400)
    }

    const data = await prisma.bookingSlot.update({ where: { id: slotId }, data: body })
    return c.json({ data })
  },
)

// ════════════════════════════════════════════════════════════════════════════
//  Bookings sheet
// ════════════════════════════════════════════════════════════════════════════

merchant.get(
  '/venues/:venueId/bookings',
  requireVenueOperator(),
  zValidator('query', z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })),
  async (c) => {
    const venueId = c.req.param('venueId')
    const { date } = c.req.valid('query')

    const data = await prisma.booking.findMany({
      where: {
        venueId,
        ...(date ? { slot: { date: new Date(date) } } : {}),
      },
      orderBy: [{ slot: { date: 'asc' } }, { slot: { startTime: 'asc' } }],
      select: {
        id: true,
        partySize: true,
        totalCents: true,
        status: true,
        paymentStatus: true,
        notes: true,
        createdAt: true,
        user: { select: { id: true, displayName: true, avatarUrl: true, avatarInitial: true } },
        slot: { select: { date: true, startTime: true, holes: true } },
      },
    })
    return c.json({ data })
  },
)

const patchBooking = z.object({
  status: z.enum(['confirmed', 'completed', 'no_show', 'cancelled']),
})

merchant.patch(
  '/venues/:venueId/bookings/:bookingId',
  requireVenueOperator(),
  zValidator('json', patchBooking),
  async (c) => {
    const venueId = c.req.param('venueId')
    const bookingId = c.req.param('bookingId')
    const { status } = c.req.valid('json')

    const booking = await prisma.booking.findFirst({ where: { id: bookingId, venueId } })
    if (!booking) return c.json({ error: '找不到預約' }, 404)

    const wasActive = booking.status === 'confirmed' || booking.status === 'pending'

    await prisma.$transaction(async (tx) => {
      // Merchant-side cancellation frees the spot; no_show / completed keep it consumed.
      if (status === 'cancelled' && wasActive) {
        await tx.$executeRaw`
          UPDATE booking_slots
             SET booked_count = GREATEST(booked_count - ${booking.partySize}, 0), updated_at = now()
           WHERE id = ${booking.slotId}::uuid
        `
        // Credit booking: refund the golfer and void the (not-yet-paid-out) amount
        // owed to the merchant — same as a user-initiated cancel.
        if (booking.creditCents > 0) {
          await grantCredits(tx, booking.userId, booking.creditCents, 'booking_refund', {
            bookingId: booking.id,
            note: 'Booking cancelled by venue',
          })
          await tx.settlementItem.updateMany({
            where: { bookingId: booking.id, status: 'accrued' },
            data: { status: 'voided' },
          })
        }
      }
      await tx.booking.update({
        where: { id: bookingId },
        data: {
          status,
          cancelledAt: status === 'cancelled' ? new Date() : booking.cancelledAt,
        },
      })
    })

    return c.json({ ok: true })
  },
)

// ════════════════════════════════════════════════════════════════════════════
//  Closures / date overrides (AvailabilityException)
// ════════════════════════════════════════════════════════════════════════════

const dateOnly = (d: Date) => d.toISOString().slice(0, 10)

merchant.get('/venues/:venueId/exceptions', requireVenueOperator(), async (c) => {
  const venueId = c.req.param('venueId')
  const rows = await prisma.availabilityException.findMany({
    where: { venueId, date: { gte: new Date(new Date().toISOString().slice(0, 10)) } },
    orderBy: { date: 'asc' },
  })
  // @db.Date serializes to a full ISO timestamp; the frontend compares YYYY-MM-DD.
  const data = rows.map((e) => ({ ...e, date: dateOnly(e.date) }))
  return c.json({ data })
})

const exceptionBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().max(120).optional(),
  // v1 supports full-day closures; custom_hours is reserved for later.
  type: z.enum(['closed']).default('closed'),
})

merchant.post(
  '/venues/:venueId/exceptions',
  requireVenueOperator('manager'),
  zValidator('json', exceptionBody),
  async (c) => {
    const venueId = c.req.param('venueId')
    const { date, reason } = c.req.valid('json')
    const day = new Date(date)

    // Upsert the closure, drop that day's open unbooked slots, and report any
    // existing active bookings the operator will need to handle out-of-band.
    const data = await prisma.availabilityException.upsert({
      where: { venueId_date: { venueId, date: day } },
      update: { type: 'closed', reason: reason ?? null },
      create: { venueId, date: day, type: 'closed', reason: reason ?? null },
    })

    const removed = await prisma.bookingSlot.deleteMany({
      where: { venueId, date: day, status: 'open', bookings: { none: {} } },
    })
    const activeBookings = await prisma.booking.count({
      where: { venueId, slot: { date: day }, status: { in: ['confirmed', 'pending'] } },
    })

    return c.json({ data: { ...data, date: dateOnly(data.date) }, removedSlots: removed.count, activeBookings }, 201)
  },
)

merchant.delete(
  '/venues/:venueId/exceptions/:exceptionId',
  requireVenueOperator('manager'),
  async (c) => {
    const venueId = c.req.param('venueId')
    const exceptionId = c.req.param('exceptionId')

    const ex = await prisma.availabilityException.findFirst({ where: { id: exceptionId, venueId } })
    if (!ex) return c.json({ error: '找不到休館設定' }, 404)

    await prisma.availabilityException.delete({ where: { id: exceptionId } })
    // Re-open availability: rebuild future rule slots (skips nothing now).
    await regenerateFuture(venueId)
    return c.json({ ok: true })
  },
)

export default merchant
