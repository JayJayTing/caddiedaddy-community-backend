/**
 * CaddieDaddy Community — Taipei Venue Seed
 *
 * Upserts curated Taipei-area golf venues (courses / driving ranges / indoor
 * simulators) as APPROVED Course rows, each with a license-clean cover image
 * (Esri satellite/street thumbnail served from frontend/public/venues/).
 *
 * Data:  scripts/data/taipei-venues.json  (built from the scrape + geocode).
 * Idempotent: upsert by deterministic id, so re-running only updates.
 *
 * PREREQUISITE: run `npm run db:push` first — the data uses the `indoor_sim`
 * VenueType value, which must exist in the DB enum.
 *
 * Usage:  npx tsx scripts/seed-venues.ts   (from backend/)
 */
import 'dotenv/config'
import { PrismaClient, VenueType, CourseStatus } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL ?? process.env.DIRECT_URL })
const prisma = new PrismaClient({ adapter })

// Same deterministic slug -> uuid v5 helper used by seed.ts, so ids are stable.
function uid(slug: string): string {
  const h = createHash('sha1').update('caddiedaddy:' + slug).digest('hex')
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`
}

interface SeedVenue {
  vid: string; venueType: string; name: string; nameEn: string
  locationText: string; city: string; district: string
  holeCount: number; lat: number; lng: number; coverPhotoUrl: string
  phone: string; website: string; coordSource: string
}

async function main() {
  const file = join(process.cwd(), 'scripts', 'data', 'taipei-venues.json')
  const venues: SeedVenue[] = JSON.parse(readFileSync(file, 'utf8'))
  console.log(`Seeding ${venues.length} Taipei venues...`)

  let n = 0
  for (const v of venues) {
    const id = uid('venue-' + v.vid)
    const data = {
      name: v.name,
      locationText: v.locationText || null,
      district: v.district || null,
      city: v.city || null,
      lat: v.lat,
      lng: v.lng,
      holeCount: v.holeCount,
      venueType: v.venueType as VenueType,
      coverPhotoUrl: v.coverPhotoUrl,
      phone: v.phone || null,
      website: v.website || null,
      status: CourseStatus.approved,
    }
    await prisma.course.upsert({ where: { id }, create: { id, ...data }, update: data })
    n++
  }
  console.log(`  ✓  Upserted ${n} venues (approved, with cover images)`)
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => { console.error(e); return prisma.$disconnect().finally(() => process.exit(1)) })
