/**
 * CaddieDaddy Community — Seed Script
 *
 * Creates 5 demo users + populates the DB with courses, rounds,
 * communities, posts, chat threads, and announcements.
 *
 * Usage:
 *   npx tsx scripts/seed.ts
 *   (or: npm run seed)
 *
 * Requires the backend to be running on PORT 3000 for user creation.
 * All other inserts go directly through Prisma.
 *
 * Idempotent: uses upsert/createMany with skipDuplicates throughout.
 */

import { PrismaClient, RoundFormat, HandicapRequirement, RoundVisibility, RoundStatus, CommunityType, CommunityPrivacy, PostType, PostVisibility, ThreadType, ParticipantRole } from '@prisma/client'

const prisma = new PrismaClient()
const API_URL = process.env.SEED_API_URL ?? 'http://localhost:3000'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function createUser(email: string, password: string, displayName: string): Promise<string> {
  const res = await fetch(`${API_URL}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, displayName }),
  })

  if (res.status === 400) {
    // User may already exist — try logging in to get the ID
    const loginRes = await fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (!loginRes.ok) {
      const body = await loginRes.text()
      throw new Error(`Login failed for ${email}: ${body}`)
    }
    const { user } = await loginRes.json()
    console.log(`  ↩  ${email} already exists — id: ${user.id}`)
    return user.id
  }

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Signup failed for ${email}: ${body}`)
  }

  const { user } = await res.json()
  console.log(`  ✓  Created ${email} — id: ${user.id}`)
  return user.id as string
}

// ─────────────────────────────────────────────────────────────────────────────
// Seed data definitions
// ─────────────────────────────────────────────────────────────────────────────

const SEED_USERS = [
  {
    email: 'alex@caddiedaddy.dev',
    password: 'Caddie2026!',
    displayName: 'Alex Johnson',
    avatarInitial: 'A',
    bio: 'Weekend golfer chasing single digits. Always down for an early morning round.',
    locationText: 'Yangmei, Taoyuan',
    handicapIndex: 8.4,
  },
  {
    email: 'mike@caddiedaddy.dev',
    password: 'Caddie2026!',
    displayName: 'Mike Chen',
    avatarInitial: 'M',
    bio: 'Playing golf since 2018. Love stroke play. Dragon Valley regular.',
    locationText: 'Zhongli, Taoyuan',
    handicapIndex: 12.0,
  },
  {
    email: 'sarah@caddiedaddy.dev',
    password: 'Caddie2026!',
    displayName: 'Sarah Lin',
    avatarInitial: 'S',
    bio: 'Single-digit player. Teaching myself to hit the driver straight.',
    locationText: 'Taipei',
    handicapIndex: 6.2,
  },
  {
    email: 'jason@caddiedaddy.dev',
    password: 'Caddie2026!',
    displayName: 'Jason Huang',
    avatarInitial: 'J',
    bio: 'Corporate golfer. Scramble format is my best chance at a good score.',
    locationText: 'Taoyuan City',
    handicapIndex: 15.5,
  },
  {
    email: 'kevin@caddiedaddy.dev',
    password: 'Caddie2026!',
    displayName: 'Kevin Ho',
    avatarInitial: 'K',
    bio: 'Beginner turned regular. Yangmei is my home course.',
    locationText: 'Yangmei, Taoyuan',
    handicapIndex: 18.2,
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🌱 CaddieDaddy Community — Seed Script\n')

  // ── Step 1: Create users ──────────────────────────────────────────────────

  console.log('Step 1: Creating users via /auth/signup...')
  const userIds: Record<string, string> = {}

  for (const u of SEED_USERS) {
    const id = await createUser(u.email, u.password, u.displayName)
    userIds[u.email] = id
  }

  const [alexId, mikeId, sarahId, jasonId, kevinId] = [
    userIds['alex@caddiedaddy.dev'],
    userIds['mike@caddiedaddy.dev'],
    userIds['sarah@caddiedaddy.dev'],
    userIds['jason@caddiedaddy.dev'],
    userIds['kevin@caddiedaddy.dev'],
  ]

  // ── Step 2: Update profile fields ────────────────────────────────────────

  console.log('\nStep 2: Updating user profiles...')

  for (const u of SEED_USERS) {
    await prisma.user.update({
      where: { id: userIds[u.email] },
      data: {
        avatarInitial: u.avatarInitial,
        bio: u.bio,
        locationText: u.locationText,
        handicapIndex: u.handicapIndex,
        memberSince: new Date('2024-01-15'),
      },
    })
    console.log(`  ✓  Updated profile for ${u.displayName}`)
  }

  // ── Step 3: Courses ───────────────────────────────────────────────────────

  console.log('\nStep 3: Creating courses...')

  const courses = await Promise.all([
    prisma.course.upsert({
      where: { id: 'course-sunrise-001' },
      create: { id: 'course-sunrise-001', name: 'Sunrise Golf Club', locationText: 'Yangmei, Taoyuan', district: 'Yangmei', city: 'Taoyuan', holeCount: 18 },
      update: {},
    }),
    prisma.course.upsert({
      where: { id: 'course-dragon-002' },
      create: { id: 'course-dragon-002', name: 'Dragon Valley GC', locationText: 'Longtan, Taoyuan', district: 'Longtan', city: 'Taoyuan', holeCount: 18 },
      update: {},
    }),
    prisma.course.upsert({
      where: { id: 'course-breeze-003' },
      create: { id: 'course-breeze-003', name: 'Breeze Links', locationText: 'Guanyin, Taoyuan', district: 'Guanyin', city: 'Taoyuan', holeCount: 9 },
      update: {},
    }),
    prisma.course.upsert({
      where: { id: 'course-tianmu-004' },
      create: { id: 'course-tianmu-004', name: 'Tianmu Golf Club', locationText: 'Tianmu, Taipei', district: 'Tianmu', city: 'Taipei', holeCount: 18 },
      update: {},
    }),
    prisma.course.upsert({
      where: { id: 'course-yangmei-005' },
      create: { id: 'course-yangmei-005', name: 'Yangmei Country Club', locationText: 'Yangmei, Taoyuan', district: 'Yangmei', city: 'Taoyuan', holeCount: 18 },
      update: {},
    }),
  ])

  console.log(`  ✓  Created ${courses.length} courses`)

  // ── Step 4: Communities ───────────────────────────────────────────────────

  console.log('\nStep 4: Creating communities...')

  const comm1 = await prisma.community.upsert({
    where: { id: 'comm-001' },
    create: {
      id: 'comm-001',
      creatorId: alexId,
      name: 'Yangmei Weekend Warriors',
      type: CommunityType.mixed,
      privacy: CommunityPrivacy.public,
      description: 'Weekend rounds in Taoyuan. All handicaps welcome. We play every Saturday and Sunday morning.',
      color1: '#B8CBE0',
      color2: '#5C7A9A',
      memberCount: 0,
    },
    update: {},
  })

  const comm2 = await prisma.community.upsert({
    where: { id: 'comm-002' },
    create: {
      id: 'comm-002',
      creatorId: sarahId,
      name: 'Sunrise Regulars',
      type: CommunityType.mixed,
      privacy: CommunityPrivacy.public,
      description: 'The Sunrise Golf Club regulars group. Early morning tee times only.',
      color1: '#C8D5BB',
      color2: '#8FA480',
      memberCount: 0,
    },
    update: {},
  })

  const comm3 = await prisma.community.upsert({
    where: { id: 'comm-003' },
    create: {
      id: 'comm-003',
      creatorId: mikeId,
      name: 'Taoyuan Weekenders',
      type: CommunityType.mixed,
      privacy: CommunityPrivacy.public,
      description: 'Casual weekend golf around Taoyuan. All skill levels.',
      color1: '#EBC6C8',
      color2: '#C4888C',
      memberCount: 0,
    },
    update: {},
  })

  const comm4 = await prisma.community.upsert({
    where: { id: 'comm-004' },
    create: {
      id: 'comm-004',
      creatorId: jasonId,
      name: 'Corporate Golf Network TW',
      type: CommunityType.corporate,
      privacy: CommunityPrivacy.invite_only,
      description: 'Taiwan corporate golf community. Networking on the fairway.',
      color1: '#DAD0E5',
      color2: '#9984B2',
      memberCount: 0,
    },
    update: {},
  })

  const comm5 = await prisma.community.upsert({
    where: { id: 'comm-005' },
    create: {
      id: 'comm-005',
      creatorId: kevinId,
      name: 'Beginner Friendly Golfers',
      type: CommunityType.beginner,
      privacy: CommunityPrivacy.public,
      description: 'A safe space for beginners. No judgment, just fun golf.',
      color1: '#F4E3B6',
      color2: '#C9A848',
      memberCount: 0,
    },
    update: {},
  })

  // Add members to communities
  const membershipData = [
    // comm1: Yangmei Weekend Warriors
    { communityId: comm1.id, userId: alexId, role: 'admin' as const },
    { communityId: comm1.id, userId: mikeId, role: 'member' as const },
    { communityId: comm1.id, userId: kevinId, role: 'member' as const },
    { communityId: comm1.id, userId: jasonId, role: 'member' as const },
    // comm2: Sunrise Regulars
    { communityId: comm2.id, userId: sarahId, role: 'admin' as const },
    { communityId: comm2.id, userId: alexId, role: 'member' as const },
    { communityId: comm2.id, userId: mikeId, role: 'member' as const },
    // comm3: Taoyuan Weekenders
    { communityId: comm3.id, userId: mikeId, role: 'admin' as const },
    { communityId: comm3.id, userId: kevinId, role: 'member' as const },
    // comm4: Corporate Golf Network TW
    { communityId: comm4.id, userId: jasonId, role: 'admin' as const },
    { communityId: comm4.id, userId: alexId, role: 'member' as const },
    // comm5: Beginner Friendly
    { communityId: comm5.id, userId: kevinId, role: 'admin' as const },
    { communityId: comm5.id, userId: jasonId, role: 'member' as const },
  ]

  for (const m of membershipData) {
    await prisma.communityMember.upsert({
      where: { communityId_userId: { communityId: m.communityId, userId: m.userId } },
      create: { communityId: m.communityId, userId: m.userId, role: m.role, status: 'active' },
      update: {},
    })
  }

  // Update member counts
  for (const comm of [comm1, comm2, comm3, comm4, comm5]) {
    const count = await prisma.communityMember.count({ where: { communityId: comm.id, status: 'active' } })
    await prisma.community.update({ where: { id: comm.id }, data: { memberCount: count } })
  }

  console.log(`  ✓  Created 5 communities with memberships`)

  // ── Step 5: Rounds ────────────────────────────────────────────────────────

  console.log('\nStep 5: Creating rounds...')

  const today = new Date()
  const addDays = (d: Date, n: number) => { const r = new Date(d); r.setDate(r.getDate() + n); return r }
  const makeTime = (h: number, m = 0) => new Date(1970, 0, 1, h, m, 0)

  const roundDefs = [
    { id: 'round-001', hostUserId: sarahId, courseId: 'course-dragon-002', date: addDays(today, 2), teeTime: makeTime(7, 0), format: RoundFormat.best_ball, holes: 18, totalSpots: 4, greenFeeCents: 280000, handicapRequirement: HandicapRequirement.u15, visibility: RoundVisibility.public, communityId: comm2.id, color1: '#CDD9E0', color2: '#7C96A3' },
    { id: 'round-002', hostUserId: mikeId, courseId: 'course-yangmei-005', date: addDays(today, 2), teeTime: makeTime(9, 0), format: RoundFormat.stroke_play, holes: 18, totalSpots: 4, greenFeeCents: 220000, handicapRequirement: HandicapRequirement.all, visibility: RoundVisibility.public, communityId: null, color1: '#DAD0E5', color2: '#9984B2' },
    { id: 'round-003', hostUserId: alexId, courseId: 'course-sunrise-001', date: addDays(today, 3), teeTime: makeTime(6, 30), format: RoundFormat.stroke_play, holes: 18, totalSpots: 4, greenFeeCents: 240000, handicapRequirement: HandicapRequirement.all, visibility: RoundVisibility.public, communityId: comm1.id, color1: '#C8D5BB', color2: '#8FA480' },
    { id: 'round-004', hostUserId: jasonId, courseId: 'course-breeze-003', date: addDays(today, 3), teeTime: makeTime(9, 15), format: RoundFormat.stableford, holes: 9, totalSpots: 3, greenFeeCents: 120000, handicapRequirement: HandicapRequirement.u20, visibility: RoundVisibility.public, communityId: null, color1: '#F5D4C1', color2: '#D99A7A' },
    { id: 'round-005', hostUserId: kevinId, courseId: 'course-tianmu-004', date: addDays(today, 4), teeTime: makeTime(5, 45), format: RoundFormat.stroke_play, holes: 18, totalSpots: 4, greenFeeCents: 260000, handicapRequirement: HandicapRequirement.all, visibility: RoundVisibility.public, communityId: null, color1: '#EBC6C8', color2: '#C4888C' },
    { id: 'round-006', hostUserId: alexId, courseId: 'course-yangmei-005', date: addDays(today, 6), teeTime: makeTime(8, 0), format: RoundFormat.scramble, holes: 18, totalSpots: 4, greenFeeCents: 220000, handicapRequirement: HandicapRequirement.u20, visibility: RoundVisibility.community, communityId: comm1.id, color1: '#F4E3B6', color2: '#C9A848' },
    { id: 'round-007', hostUserId: sarahId, courseId: 'course-dragon-002', date: addDays(today, 9), teeTime: makeTime(7, 30), format: RoundFormat.best_ball, holes: 18, totalSpots: 4, greenFeeCents: 280000, handicapRequirement: HandicapRequirement.u15, visibility: RoundVisibility.public, communityId: null, color1: '#CDD9E0', color2: '#7C96A3' },
    { id: 'round-008', hostUserId: mikeId, courseId: 'course-sunrise-001', date: addDays(today, 10), teeTime: makeTime(6, 0), format: RoundFormat.stroke_play, holes: 18, totalSpots: 4, greenFeeCents: 240000, handicapRequirement: HandicapRequirement.all, visibility: RoundVisibility.public, communityId: comm2.id, color1: '#C8D5BB', color2: '#8FA480' },
  ]

  for (const r of roundDefs) {
    await prisma.round.upsert({
      where: { id: r.id },
      create: {
        id: r.id,
        hostUserId: r.hostUserId,
        courseId: r.courseId,
        date: r.date,
        teeTime: r.teeTime,
        format: r.format,
        holes: r.holes,
        totalSpots: r.totalSpots,
        greenFeeCents: r.greenFeeCents,
        handicapRequirement: r.handicapRequirement,
        visibility: r.visibility,
        communityId: r.communityId,
        color1: r.color1,
        color2: r.color2,
        status: RoundStatus.open,
      },
      update: {},
    })

    // Add host as participant
    await prisma.roundParticipant.upsert({
      where: { roundId_userId: { roundId: r.id, userId: r.hostUserId } },
      create: { roundId: r.id, userId: r.hostUserId, role: ParticipantRole.host },
      update: {},
    })
  }

  // Add some accepted participants
  const participantData = [
    { roundId: 'round-001', userId: mikeId },
    { roundId: 'round-003', userId: kevinId },
    { roundId: 'round-006', userId: mikeId },
    { roundId: 'round-006', userId: sarahId },
    { roundId: 'round-008', userId: alexId },
  ]

  for (const p of participantData) {
    await prisma.roundParticipant.upsert({
      where: { roundId_userId: { roundId: p.roundId, userId: p.userId } },
      create: { roundId: p.roundId, userId: p.userId, role: ParticipantRole.accepted },
      update: {},
    })
  }

  console.log(`  ✓  Created 8 rounds with participants`)

  // ── Step 6: Posts ─────────────────────────────────────────────────────────

  console.log('\nStep 6: Creating posts...')

  const postDefs = [
    {
      id: 'post-001',
      authorId: jasonId,
      type: PostType.round_report,
      body: 'Shot my best 9 holes yet — 38 on the East course at Sunrise. Conditions were perfect this morning. The greens were lightning fast but I managed to two-putt most of them. Anyone up for a rematch next weekend?',
      locationText: 'Sunrise Golf Club',
      visibility: PostVisibility.public,
      communityIds: [comm2.id],
    },
    {
      id: 'post-002',
      authorId: kevinId,
      type: PostType.seeking,
      body: 'Looking for 2 more players for Dragon Valley GC this Sunday 7am. Best Ball format. HCP under 20 preferred. Green fee is NT$2,800. Reply here or DM me!',
      locationText: 'Dragon Valley GC',
      visibility: PostVisibility.public,
      communityIds: [comm3.id],
      isLfp: true,
      lfpPlayersNeeded: 2,
    },
    {
      id: 'post-003',
      authorId: sarahId,
      type: PostType.tip,
      body: 'Hot tip for Yangmei CC: the 14th hole plays 2 clubs longer than the yardage suggests due to the prevailing afternoon wind. Take extra club and aim left of the bunker. Saved me 3 strokes on my last round.',
      locationText: 'Yangmei Country Club',
      visibility: PostVisibility.public,
      communityIds: [comm1.id, comm2.id],
    },
    {
      id: 'post-004',
      authorId: alexId,
      type: PostType.round_report,
      body: 'Great scramble with the Yangmei Weekend Warriors today! Shot 62 as a team on the full 18 at Yangmei CC. Kevin made an incredible 30-foot birdie putt on 17. Post-round cold beers were earned.',
      locationText: 'Yangmei Country Club',
      visibility: PostVisibility.public,
      communityIds: [comm1.id],
    },
    {
      id: 'post-005',
      authorId: mikeId,
      type: PostType.general,
      body: 'Just booked tee times at Dragon Valley for the next three Saturdays. The new clubhouse renovation is finished and the facilities are amazing. Highly recommend checking it out.',
      locationText: 'Dragon Valley GC',
      visibility: PostVisibility.public,
      communityIds: [comm3.id],
    },
    {
      id: 'post-006',
      authorId: jasonId,
      type: PostType.seeking,
      body: 'Need one more for a corporate round at Tianmu GC on Friday afternoon. Stableford format, HCP under 15. Client entertainment — professional demeanor required. DM if interested.',
      locationText: 'Tianmu Golf Club',
      visibility: PostVisibility.public,
      communityIds: [comm4.id],
      isLfp: true,
      lfpPlayersNeeded: 1,
    },
  ]

  for (const p of postDefs) {
    await prisma.post.upsert({
      where: { id: p.id },
      create: {
        id: p.id,
        authorId: p.authorId,
        type: p.type,
        body: p.body,
        locationText: p.locationText ?? null,
        visibility: p.visibility,
        isLfp: p.isLfp ?? false,
        lfpPlayersNeeded: p.lfpPlayersNeeded ?? null,
        status: 'active',
      },
      update: {},
    })

    // Link to communities
    for (const communityId of (p.communityIds ?? [])) {
      await prisma.postCommunity.upsert({
        where: { postId_communityId: { postId: p.id, communityId } },
        create: { postId: p.id, communityId },
        update: {},
      })
    }
  }

  // Add some likes and comments
  const likes = [
    { postId: 'post-001', userId: mikeId },
    { postId: 'post-001', userId: sarahId },
    { postId: 'post-001', userId: alexId },
    { postId: 'post-003', userId: alexId },
    { postId: 'post-003', userId: kevinId },
    { postId: 'post-004', userId: sarahId },
    { postId: 'post-004', userId: kevinId },
    { postId: 'post-004', userId: jasonId },
  ]

  for (const l of likes) {
    await prisma.postLike.upsert({
      where: { postId_userId: { postId: l.postId, userId: l.userId } },
      create: { postId: l.postId, userId: l.userId },
      update: {},
    })
  }

  // Update like counts
  for (const p of postDefs) {
    const count = await prisma.postLike.count({ where: { postId: p.id } })
    await prisma.post.update({ where: { id: p.id }, data: { likesCount: count } })
  }

  const comments = [
    { postId: 'post-001', authorId: mikeId, text: 'Amazing! What was your score on the back 9?' },
    { postId: 'post-001', authorId: sarahId, text: "Let's go next Saturday! I need a good warm-up before the club tournament." },
    { postId: 'post-001', authorId: alexId, text: '38 is great on that course. Greens were tough last time I played there.' },
    { postId: 'post-003', authorId: mikeId, text: 'This is gold, thank you! Always lost strokes on 14.' },
    { postId: 'post-004', authorId: kevinId, text: "That putt was pure luck haha. But I'll take it! 🏌️" },
    { postId: 'post-004', authorId: sarahId, text: "Great round everyone. Same time next week?" },
  ]

  for (const cmt of comments) {
    await prisma.comment.create({ data: { postId: cmt.postId, authorId: cmt.authorId, text: cmt.text } }).catch(() => {})
  }

  // Update comment counts
  for (const p of postDefs) {
    const count = await prisma.comment.count({ where: { postId: p.id, deletedAt: null } })
    await prisma.post.update({ where: { id: p.id }, data: { commentsCount: count } })
  }

  console.log(`  ✓  Created 6 posts with likes and comments`)

  // ── Step 7: Chat threads ──────────────────────────────────────────────────

  console.log('\nStep 7: Creating chat threads...')

  const threads = [
    {
      id: 'thread-dm-alex-mike',
      type: ThreadType.dm,
      name: null,
      participants: [alexId, mikeId],
      messages: [
        { senderId: mikeId, text: 'Hey Alex, still on for Saturday morning?' },
        { senderId: alexId, text: 'Absolutely! 6:30 tee time at Sunrise. See you there.' },
        { senderId: mikeId, text: 'See you on the course! ⛳' },
      ],
    },
    {
      id: 'thread-dm-alex-sarah',
      type: ThreadType.dm,
      name: null,
      participants: [alexId, sarahId],
      messages: [
        { senderId: sarahId, text: 'Great tip on the 14th hole. Wish I had known sooner!' },
        { senderId: alexId, text: 'Ha, cost me so many shots before I figured it out.' },
      ],
    },
    {
      id: 'thread-dm-jason-kevin',
      type: ThreadType.dm,
      name: null,
      participants: [jasonId, kevinId],
      messages: [
        { senderId: jasonId, text: 'Kevin, are you interested in the corporate round Friday?' },
        { senderId: kevinId, text: 'Thanks for thinking of me! Might be a bit above my skill level though 😅' },
      ],
    },
    {
      id: 'thread-group-yangmei',
      type: ThreadType.group,
      name: 'Yangmei Weekend Warriors',
      communityId: comm1.id,
      participants: [alexId, mikeId, kevinId, jasonId],
      messages: [
        { senderId: alexId, text: 'Good round today everyone! Same time next week?' },
        { senderId: mikeId, text: 'I\'m in! Can we do Sunday instead this time?' },
        { senderId: kevinId, text: 'Sunday works for me 👍' },
        { senderId: alexId, text: 'Sunday 7am it is. I\'ll post the round.' },
      ],
    },
    {
      id: 'thread-group-sunrise',
      type: ThreadType.group,
      name: 'Sunrise Regulars',
      communityId: comm2.id,
      participants: [sarahId, alexId, mikeId],
      messages: [
        { senderId: sarahId, text: 'Morning everyone! Greens are perfect today.' },
        { senderId: alexId, text: 'Great conditions! Best round I\'ve had this month.' },
      ],
    },
  ]

  for (const thread of threads) {
    const created = await prisma.chatThread.upsert({
      where: { id: thread.id },
      create: {
        id: thread.id,
        type: thread.type,
        name: thread.name ?? null,
        communityId: (thread as any).communityId ?? null,
      },
      update: {},
    })

    // Add participants
    for (const userId of thread.participants) {
      await prisma.threadParticipant.upsert({
        where: { threadId_userId: { threadId: created.id, userId } },
        create: { threadId: created.id, userId },
        update: {},
      })
    }

    // Add messages
    for (const msg of thread.messages) {
      await prisma.message.create({
        data: { threadId: created.id, senderId: msg.senderId, text: msg.text },
      }).catch(() => {})
    }

    // Update lastMessageAt
    const lastMsg = await prisma.message.findFirst({
      where: { threadId: created.id },
      orderBy: { createdAt: 'desc' },
    })
    if (lastMsg) {
      await prisma.chatThread.update({ where: { id: created.id }, data: { lastMessageAt: lastMsg.createdAt } })
    }
  }

  console.log(`  ✓  Created 5 chat threads with messages`)

  // ── Step 8: Announcements ─────────────────────────────────────────────────

  console.log('\nStep 8: Creating announcements...')

  const announcements = [
    {
      id: 'ann-001',
      authorId: alexId,
      badge: 'Announcement',
      title: 'Summer Scramble Series starts July 5',
      body: 'Sign-ups are open for our 4-week summer scramble. Register your team of 2–4 by June 30. NT$3,000 entry per team. Prizes for top 3 teams.',
      publishedAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
    {
      id: 'ann-002',
      authorId: sarahId,
      badge: 'Rule Update',
      title: 'New local rule: preferred lies until July',
      body: 'Due to recent course maintenance, preferred lies (lift, clean and place within 6 inches) are in effect on all fairways until July 15. Rough and bunkers play as normal.',
      publishedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      expiresAt: new Date(Date.now() + 25 * 24 * 60 * 60 * 1000),
    },
    {
      id: 'ann-003',
      authorId: mikeId,
      badge: 'Course Notice',
      title: 'Dragon Valley holes 7–9 closed this weekend',
      body: 'Dragon Valley GC has notified us that holes 7, 8, and 9 will be temporarily closed for irrigation work this Saturday and Sunday. They are offering a 10% green fee discount.',
      publishedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    },
  ]

  for (const ann of announcements) {
    await prisma.announcement.upsert({
      where: { id: ann.id },
      create: ann,
      update: {},
    })
  }

  console.log(`  ✓  Created 3 announcements`)

  // ── Done ──────────────────────────────────────────────────────────────────

  console.log('\n✅ Seed complete!\n')
  console.log('─────────────────────────────────────────────')
  console.log('Test accounts (all passwords: Caddie2026!):')
  console.log('─────────────────────────────────────────────')
  for (const u of SEED_USERS) {
    console.log(`  ${u.displayName.padEnd(16)} ${u.email}`)
  }
  console.log('─────────────────────────────────────────────\n')
}

main()
  .catch(e => { console.error('\n❌ Seed failed:', e); process.exit(1) })
  .finally(() => prisma.$disconnect())
