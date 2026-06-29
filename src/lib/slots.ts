import { prisma } from './prisma'

// Times are stored timezone-naive on the 1970-01-01 epoch date in UTC, matching
// how Round.teeTime is handled elsewhere in the app ("07:00" → 07:00 UTC).
function minutesToTime(min: number): Date {
  const d = new Date('1970-01-01T00:00:00.000Z')
  d.setUTCHours(Math.floor(min / 60), min % 60, 0, 0)
  return d
}

function utcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * Materialize a venue's active AvailabilityRules into concrete BookingSlot rows
 * across the inclusive date range [from, to]. Dates with a `closed`
 * AvailabilityException are skipped entirely. All rows are stamped source='rule'.
 *
 * Idempotent: relies on the @@unique([venueId, date, startTime, holes]) constraint
 * plus `skipDuplicates`, so re-running over an overlapping range never duplicates
 * or overwrites existing (possibly already-booked, blocked, or manual) slots.
 *
 * Returns the number of new slots created.
 */
export async function generateSlots(venueId: string, from: Date, to: Date): Promise<number> {
  const start = utcMidnight(from)
  const end = utcMidnight(to)

  const [rules, closedDates] = await Promise.all([
    prisma.availabilityRule.findMany({ where: { venueId, active: true } }),
    prisma.availabilityException.findMany({
      where: { venueId, type: 'closed', date: { gte: start, lte: end } },
      select: { date: true },
    }),
  ])
  if (rules.length === 0) return 0
  const closed = new Set(closedDates.map((e) => isoDay(e.date)))

  // Guard against duplicates explicitly. The @@unique([venueId,date,startTime,holes])
  // index does NOT dedupe rows where holes IS NULL (Postgres treats NULLs as
  // distinct), so driving ranges (holes=null) would otherwise accumulate copies
  // every run. Track existing (date|HH:MM|holes) keys and skip them.
  const existingSlots = await prisma.bookingSlot.findMany({
    where: { venueId, date: { gte: start, lte: end } },
    select: { date: true, startTime: true, holes: true },
  })
  const keyOf = (dayIso: string, label: string, holes: number | null) =>
    `${dayIso}|${label}|${holes ?? '_'}`
  const minLabel = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  const seen = new Set(
    existingSlots.map((s) => keyOf(isoDay(s.date), s.startTime.toISOString().slice(11, 16), s.holes)),
  )

  const rows: {
    venueId: string
    ruleId: string
    date: Date
    startTime: Date
    holes: number | null
    capacity: number
    priceCents: number
    creditPriceCents: number | null
    source: 'rule'
  }[] = []

  for (let d = start; d <= end; d = new Date(d.getTime() + 86_400_000)) {
    if (closed.has(isoDay(d))) continue // venue closed that date
    const weekday = d.getUTCDay() // 0 = Sunday … 6 = Saturday
    for (const rule of rules) {
      if ((rule.weekdayMask & (1 << weekday)) === 0) continue
      if (rule.validFrom && d < utcMidnight(rule.validFrom)) continue
      if (rule.validTo && d > utcMidnight(rule.validTo)) continue

      for (let m = rule.startMinute; m <= rule.endMinute; m += rule.intervalMin) {
        const key = keyOf(isoDay(d), minLabel(m), rule.holes ?? null)
        if (seen.has(key)) continue // already exists (or queued) → never duplicate
        seen.add(key)
        rows.push({
          venueId,
          ruleId: rule.id,
          date: new Date(d),
          startTime: minutesToTime(m),
          holes: rule.holes ?? null,
          capacity: rule.capacity,
          priceCents: rule.priceCents,
          creditPriceCents: rule.creditPriceCents ?? null,
          source: 'rule',
        })
      }
    }
  }

  if (rows.length === 0) return 0

  const result = await prisma.bookingSlot.createMany({ data: rows, skipDuplicates: true })
  return result.count
}

/**
 * Reconcile future rule-generated slots after the schedule changes. Deletes
 * future, OPEN, UNBOOKED, rule-sourced slots and re-materializes them from the
 * current active rules — so edited prices/capacities/hours take effect going
 * forward. Preserves: past slots, booked slots (bookedCount>0), blocked slots,
 * and manual/imported slots (source != 'rule'). Horizon = today …
 * today + venue.advanceBookingDays.
 *
 * Returns the number of slots created by the regeneration.
 */
export async function regenerateFuture(venueId: string): Promise<number> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { advanceBookingDays: true },
  })
  if (!venue) return 0

  const today = utcMidnight(new Date())
  const horizonEnd = new Date(today.getTime() + venue.advanceBookingDays * 86_400_000)

  // Only delete slots with NO booking rows at all — a cancelled booking still
  // references its slot (FK), so `bookedCount: 0` isn't enough; `bookings: none`
  // is, and it also preserves any slot a golfer has history with.
  await prisma.bookingSlot.deleteMany({
    where: {
      venueId,
      date: { gte: today },
      status: 'open',
      source: 'rule',
      bookings: { none: {} },
    },
  })

  return generateSlots(venueId, today, horizonEnd)
}

/**
 * Add a single one-off slot (operator-created, e.g. an extra tee time or a
 * makeup session). Stamped source='manual' so regenerateFuture never wipes it.
 * Throws on a duplicate (venueId, date, startTime, holes).
 */
export async function addManualSlot(
  venueId: string,
  input: {
    date: Date
    startMinute: number
    holes: number | null
    capacity: number
    priceCents: number
    creditPriceCents: number | null
  },
) {
  return prisma.bookingSlot.create({
    data: {
      venueId,
      ruleId: null,
      date: utcMidnight(input.date),
      startTime: minutesToTime(input.startMinute),
      holes: input.holes,
      capacity: input.capacity,
      priceCents: input.priceCents,
      creditPriceCents: input.creditPriceCents,
      source: 'manual',
    },
  })
}

// ── Future seam (NOT wired): external tee-sheet / Excel import ──────────────────
// An importer would map external rows → BookingSlot rows stamped source='import'
// with an `externalRef`, then `createMany({ data, skipDuplicates: true })` against
// the same @@unique([venueId, date, startTime, holes]) key so imported slots dedupe
// against rule-generated ones for free. Mirror this signature when building it:
//
//   export async function importSlots(venueId: string, rows: ImportRow[]): Promise<number>
