/**
 * Manually confirm a pending credit purchase (pilot top-up — no PSP yet).
 * Marks the purchase `paid` and grants the credits, idempotently. This is the
 * same `confirmPurchase` seam a real payment webhook will call later.
 *
 * Usage:
 *   npx tsx scripts/confirm-purchase.ts <purchaseId>
 */
import 'dotenv/config'
import { confirmPurchase } from '../src/lib/credits'
import { prisma } from '../src/lib/prisma'

async function main() {
  const id = process.argv[2]
  if (!id) {
    console.error('Usage: npx tsx scripts/confirm-purchase.ts <purchaseId>')
    process.exit(1)
  }

  const result = await confirmPurchase(id)
  const balance =
    result.balanceCents != null ? ` — balance now NT$${Math.round(result.balanceCents / 100).toLocaleString()}` : ''
  console.log(`Purchase ${id}: ${result.status}${balance}`)
}

main()
  .catch((e) => {
    console.error('confirm-purchase failed:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
