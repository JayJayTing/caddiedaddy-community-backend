import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { authMiddleware } from '../middleware/auth'
import { grantCredits } from '../lib/credits'

const bookings = new Hono()

// Combine a @db.Date (UTC midnight) with a @db.Time (epoch-date time) into one
// instant. Times are treated as naive UTC, consistent with the rest of the app.
function slotStartInstant(date: Date, time: Date): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      time.getUTCHours(),
      time.getUTCMinutes(),
      0,
      0,
    ),
  )
}

// ── GET /bookings/mine — current user's bookings ────────────────────────────────

bookings.get('/mine', authMiddleware, async (c) => {
  const { sub: userId } = c.get('user')

  const data = await prisma.booking.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      partySize: true,
      totalCents: true,
      creditCents: true,
      status: true,
      paymentStatus: true,
      createdAt: true,
      venue: { select: { id: true, name: true, locationText: true, paymentMode: true } },
      slot: { select: { date: true, startTime: true, holes: true } },
    },
  })

  return c.json({ data })
})

// ── POST /bookings/:id/cancel — cancel own booking, frees the slot ──────────────

bookings.post('/:id/cancel', authMiddleware, async (c) => {
  const { sub: userId } = c.get('user')
  const id = c.req.param('id')

  const booking = await prisma.booking.findUnique({
    where: { id },
    include: {
      slot: { select: { date: true, startTime: true } },
      venue: { select: { cancellationCutoffHours: true } },
    },
  })

  if (!booking) return c.json({ error: '找不到預約' }, 404)
  if (booking.userId !== userId) return c.json({ error: '這不是你的預約' }, 403)
  if (booking.status === 'cancelled') return c.json({ error: '此預約已取消' }, 400)
  if (booking.status !== 'confirmed' && booking.status !== 'pending') {
    return c.json({ error: '此預約已無法取消' }, 400)
  }

  const start = slotStartInstant(booking.slot.date, booking.slot.startTime)
  const cutoffMs = booking.venue.cancellationCutoffHours * 3_600_000
  if (start.getTime() - Date.now() < cutoffMs) {
    return c.json(
      {
        error: `預約須在開球時間前至少 ${booking.venue.cancellationCutoffHours} 小時取消`,
      },
      400,
    )
  }

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE booking_slots
         SET booked_count = GREATEST(booked_count - ${booking.partySize}, 0), updated_at = now()
       WHERE id = ${booking.slotId}::uuid
    `
    await tx.booking.update({
      where: { id },
      data: { status: 'cancelled', cancelledAt: new Date() },
    })

    // Credit booking: refund the wallet and void the (not-yet-paid-out) amount
    // owed to the merchant. Safe while payouts are deferred — nothing is `paid`.
    if (booking.creditCents > 0) {
      await grantCredits(tx, userId, booking.creditCents, 'booking_refund', {
        bookingId: booking.id,
        note: 'Booking cancelled',
      })
      await tx.settlementItem.updateMany({
        where: { bookingId: booking.id, status: 'accrued' },
        data: { status: 'voided' },
      })
    }
  })

  return c.json({ ok: true })
})

export default bookings
