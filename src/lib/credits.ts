// Credit-wallet money primitives. All mutating helpers take a transaction client
// so a booking can claim a slot, spend credits, and record settlement atomically.
//
// Model: credits are par with NT$ (1 credit = NT$0.01, stored in cents).
// CreditAccount.balanceCents is the denormalized balance (same pattern as
// BookingSlot.bookedCount); CreditLedgerEntry is the append-only audit trail.
import { Prisma, type CreditEntryType } from '@prisma/client'
import { HTTPException } from 'hono/http-exception'
import { prisma } from './prisma'

type Tx = Prisma.TransactionClient

/**
 * Platform commission on a credit booking, in cents. Defined here once so the
 * (deferred) monthly settlement report always agrees with what was accrued.
 */
export function commissionForCents(grossCents: number, bps: number): number {
  return Math.round((grossCents * bps) / 10000)
}

/** Ensure the caller has a wallet row; returns its id + current balance. */
async function ensureAccount(tx: Tx, userId: string): Promise<{ id: string; balanceCents: number }> {
  const existing = await tx.creditAccount.findUnique({
    where: { userId },
    select: { id: true, balanceCents: true },
  })
  if (existing) return existing
  return tx.creditAccount.create({ data: { userId }, select: { id: true, balanceCents: true } })
}

/**
 * Add credits (purchase / bonus / refund / positive adjustment) and append a
 * ledger entry. Returns the new balance.
 */
export async function grantCredits(
  tx: Tx,
  userId: string,
  cents: number,
  type: CreditEntryType,
  refs?: { bookingId?: string; purchaseId?: string; note?: string },
): Promise<number> {
  if (cents <= 0) throw new Error('grantCredits: cents must be positive')
  const account = await ensureAccount(tx, userId)
  // The update locks the row, so the returned balance is the true post-state.
  const updated = await tx.creditAccount.update({
    where: { id: account.id },
    data: { balanceCents: { increment: cents } },
    select: { balanceCents: true },
  })
  await tx.creditLedgerEntry.create({
    data: {
      accountId: account.id,
      type,
      deltaCents: cents,
      balanceAfterCents: updated.balanceCents,
      bookingId: refs?.bookingId ?? null,
      purchaseId: refs?.purchaseId ?? null,
      note: refs?.note ?? null,
    },
  })
  return updated.balanceCents
}

/**
 * Spend credits, oversell-safe. The conditional UPDATE mirrors the slot-claim
 * pattern in routes/venues.ts: the row is only debited if the balance covers it,
 * so concurrent spends can never drive it negative. Throws 409 on shortfall.
 * Returns the new balance.
 */
export async function spendCredits(
  tx: Tx,
  userId: string,
  cents: number,
  bookingId?: string,
): Promise<number> {
  if (cents <= 0) throw new Error('spendCredits: cents must be positive')
  const account = await ensureAccount(tx, userId)
  const debited = await tx.$executeRaw`
    UPDATE credit_accounts
       SET balance_cents = balance_cents - ${cents}, updated_at = now()
     WHERE id = ${account.id}::uuid
       AND balance_cents >= ${cents}
  `
  if (debited === 0) {
    throw new HTTPException(409, { message: '點數餘額不足' })
  }
  const after = await tx.creditAccount.findUniqueOrThrow({
    where: { id: account.id },
    select: { balanceCents: true },
  })
  await tx.creditLedgerEntry.create({
    data: {
      accountId: account.id,
      type: 'booking_spend',
      deltaCents: -cents,
      balanceAfterCents: after.balanceCents,
      bookingId: bookingId ?? null,
    },
  })
  return after.balanceCents
}

/**
 * Confirm a pending purchase: mark it paid and grant the credits, atomically.
 * Idempotent — a non-pending purchase is a no-op. This is the seam a real PSP
 * webhook will call later; today it's driven by /credits/purchase auto-confirm
 * (pilot) or the confirm-purchase admin script.
 */
export async function confirmPurchase(
  purchaseId: string,
): Promise<{ status: string; balanceCents: number | null }> {
  return prisma.$transaction(async (tx) => {
    const purchase = await tx.creditPurchase.findUnique({ where: { id: purchaseId } })
    if (!purchase) throw new HTTPException(404, { message: '找不到購買紀錄' })
    if (purchase.status !== 'pending') {
      return { status: purchase.status, balanceCents: null }
    }
    await tx.creditPurchase.update({ where: { id: purchaseId }, data: { status: 'paid' } })
    const balanceCents = await grantCredits(tx, purchase.userId, purchase.creditCents, 'purchase', {
      purchaseId: purchase.id,
      note: 'Credit purchase',
    })
    return { status: 'paid', balanceCents }
  })
}
