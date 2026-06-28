import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { authMiddleware } from '../middleware/auth'

const chat = new Hono()

// ── Shared selects ─────────────────────────────────────────────────────────────

const participantUserSelect = {
  id: true,
  displayName: true,
  avatarInitial: true,
  avatarUrl: true,
} as const

const senderSelect = {
  id: true,
  displayName: true,
  avatarInitial: true,
  avatarUrl: true,
} as const

// ── GET /threads ───────────────────────────────────────────────────────────────

chat.get('/', authMiddleware, async (c) => {
  const { sub: userId } = c.get('user')

  const data = await prisma.chatThread.findMany({
    where: {
      participants: {
        some: { userId, leftAt: null },
      },
    },
    include: {
      participants: {
        where: { leftAt: null },
        include: { user: { select: participantUserSelect } },
      },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: {
          id: true,
          text: true,
          createdAt: true,
          sender: { select: senderSelect },
        },
      },
    },
    orderBy: { lastMessageAt: 'desc' },
  })

  return c.json({ data })
})

// ── GET /threads/:id/messages ──────────────────────────────────────────────────

const messagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
})

chat.get('/:id/messages', authMiddleware, zValidator('query', messagesQuerySchema), async (c) => {
  const { sub: userId } = c.get('user')
  const threadId = c.req.param('id')
  const { limit, offset } = c.req.valid('query')

  // Verify participant
  const participant = await prisma.threadParticipant.findUnique({
    where: { threadId_userId: { threadId, userId } },
  })
  if (!participant || participant.leftAt !== null) {
    return c.json({ error: 'Not a participant in this thread' }, 403)
  }

  const data = await prisma.message.findMany({
    where: { threadId, deletedAt: null },
    include: { sender: { select: senderSelect } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset,
  })

  return c.json({ data })
})

// ── POST /threads/:id/messages ─────────────────────────────────────────────────

const sendMessageSchema = z.object({
  text: z.string().min(1),
})

chat.post('/:id/messages', authMiddleware, zValidator('json', sendMessageSchema), async (c) => {
  const { sub: userId } = c.get('user')
  const threadId = c.req.param('id')
  const { text } = c.req.valid('json')

  // Verify participant
  const participant = await prisma.threadParticipant.findUnique({
    where: { threadId_userId: { threadId, userId } },
  })
  if (!participant || participant.leftAt !== null) {
    return c.json({ error: 'Not a participant in this thread' }, 403)
  }

  const thread = await prisma.chatThread.findUnique({ where: { id: threadId } })
  if (!thread) return c.json({ error: 'Thread not found' }, 404)

  const [data] = await prisma.$transaction([
    prisma.message.create({
      data: { threadId, senderId: userId, text },
      include: { sender: { select: senderSelect } },
    }),
    prisma.chatThread.update({
      where: { id: threadId },
      data: { lastMessageAt: new Date() },
    }),
  ])

  return c.json({ data }, 201)
})

// ── POST /threads (create or find a DM with another user) ───────────────────────

const createDmSchema = z.object({
  userId: z.string().uuid(),
})

chat.post('/', authMiddleware, zValidator('json', createDmSchema), async (c) => {
  const { sub: userId } = c.get('user')
  const { userId: targetId } = c.req.valid('json')

  if (targetId === userId) return c.json({ error: 'Cannot DM yourself' }, 400)
  const target = await prisma.user.findUnique({ where: { id: targetId } })
  if (!target) return c.json({ error: 'User not found' }, 404)

  const threadInclude = {
    participants: { where: { leftAt: null }, include: { user: { select: participantUserSelect } } },
  } as const

  // Find an existing DM thread that both users are in.
  const existing = await prisma.chatThread.findFirst({
    where: {
      type: 'dm',
      AND: [
        { participants: { some: { userId } } },
        { participants: { some: { userId: targetId } } },
      ],
    },
    include: threadInclude,
  })
  if (existing) return c.json({ data: existing })

  const data = await prisma.chatThread.create({
    data: {
      type: 'dm',
      participants: { create: [{ userId }, { userId: targetId }] },
    },
    include: threadInclude,
  })

  return c.json({ data }, 201)
})

// ── PATCH /threads/:id/read (mark thread read for current user) ──────────────────

chat.patch('/:id/read', authMiddleware, async (c) => {
  const { sub: userId } = c.get('user')
  const threadId = c.req.param('id')

  const participant = await prisma.threadParticipant.findUnique({
    where: { threadId_userId: { threadId, userId } },
  })
  if (!participant) return c.json({ error: 'Not a participant in this thread' }, 403)

  await prisma.threadParticipant.update({
    where: { threadId_userId: { threadId, userId } },
    data: { lastReadAt: new Date() },
  })

  return c.json({ ok: true })
})

export default chat
