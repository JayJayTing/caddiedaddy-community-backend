import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { authMiddleware } from '../middleware/auth'
import { createNotification } from '../lib/notifications'

const posts = new Hono()

// ── Shared selects ─────────────────────────────────────────────────────────────

const authorSelect = {
  id: true,
  displayName: true,
  avatarInitial: true,
  avatarUrl: true,
  locationText: true,
} as const

const commentAuthorSelect = {
  id: true,
  displayName: true,
  avatarInitial: true,
  avatarUrl: true,
} as const

// ── GET /posts ─────────────────────────────────────────────────────────────────

const feedQuerySchema = z.object({
  scope: z.enum(['discover', 'following', 'community']).default('discover'),
  type: z.enum(['round_report', 'seeking', 'tip', 'general', 'announcement']).optional(),
  communityId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
})

posts.get('/', zValidator('query', feedQuerySchema), async (c) => {
  const { scope, type, communityId, limit, offset } = c.req.valid('query')

  // For 'following' scope we need the authed user's communities
  let userCommunityIds: string[] | undefined

  if (scope === 'following') {
    const authHeader = c.req.header('Authorization')
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ error: '查看追蹤動態需要登入' }, 401)
    }
    // authMiddleware is not applied to keep route open for discover/community,
    // so verify the token inline using the shared Supabase JWKS verifier.
    const { verifySupabaseToken } = await import('../lib/supabaseJwt')
    try {
      const decoded = await verifySupabaseToken(authHeader.slice(7))
      const memberships = await prisma.communityMember.findMany({
        where: { userId: decoded.sub, status: 'active' },
        select: { communityId: true },
      })
      userCommunityIds = memberships.map((m) => m.communityId)
    } catch {
      return c.json({ error: '權杖無效或已過期' }, 401)
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = { status: 'active', deletedAt: null }

  if (type) where.type = type

  if (scope === 'community') {
    if (!communityId) return c.json({ error: '社群範圍需要提供 communityId' }, 400)
    where.communities = { some: { communityId } }
  } else if (scope === 'following' && userCommunityIds) {
    where.communities = { some: { communityId: { in: userCommunityIds } } }
  }
  // 'discover' — no extra community filter; returns all public posts

  const data = await prisma.post.findMany({
    where,
    include: {
      author: { select: authorSelect },
      communities: {
        select: {
          communityId: true,
          community: { select: { name: true } },
        },
      },
      _count: { select: { likes: true, comments: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset,
  })

  return c.json({ data })
})

// ── POST /posts ────────────────────────────────────────────────────────────────

const createPostSchema = z.object({
  type: z.enum(['round_report', 'seeking', 'tip', 'general', 'announcement']),
  body: z.string().min(1),
  locationText: z.string().optional(),
  photoUrl: z.string().url().optional(),
  visibility: z.enum(['public', 'community']),
  communityIds: z.array(z.string().uuid()).optional(),
  isLfp: z.boolean().optional(),
  lfpPlayersNeeded: z.number().int().positive().optional(),
})

posts.post('/', authMiddleware, zValidator('json', createPostSchema), async (c) => {
  const { sub: userId } = c.get('user')
  const body = c.req.valid('json')

  const data = await prisma.post.create({
    data: {
      authorId: userId,
      type: body.type,
      body: body.body,
      locationText: body.locationText,
      photoUrl: body.photoUrl,
      visibility: body.visibility,
      isLfp: body.isLfp ?? false,
      lfpPlayersNeeded: body.lfpPlayersNeeded,
      communities: body.communityIds?.length
        ? {
            create: body.communityIds.map((communityId) => ({ communityId })),
          }
        : undefined,
    },
    include: {
      author: { select: authorSelect },
      communities: {
        select: {
          communityId: true,
          community: { select: { name: true } },
        },
      },
      _count: { select: { likes: true, comments: true } },
    },
  })

  return c.json({ data }, 201)
})

// ── GET /posts/:id ─────────────────────────────────────────────────────────────
// Single post (for notification deep-links into PostDetailOverlay).

posts.get('/:id', async (c) => {
  const id = c.req.param('id')
  const data = await prisma.post.findUnique({
    where: { id },
    include: {
      author: { select: authorSelect },
      communities: { select: { communityId: true, community: { select: { name: true } } } },
      _count: { select: { likes: true, comments: true } },
    },
  })
  if (!data || data.deletedAt) return c.json({ error: '找不到貼文' }, 404)
  return c.json({ data })
})

// ── POST /posts/:id/like ───────────────────────────────────────────────────────

posts.post('/:id/like', authMiddleware, async (c) => {
  const { sub: userId } = c.get('user')
  const postId = c.req.param('id')

  const post = await prisma.post.findUnique({ where: { id: postId } })
  if (!post) return c.json({ error: '找不到貼文' }, 404)

  const existing = await prisma.postLike.findUnique({
    where: { postId_userId: { postId, userId } },
  })

  if (existing) {
    // Unlike — delete + decrement
    await prisma.$transaction([
      prisma.postLike.delete({ where: { postId_userId: { postId, userId } } }),
      prisma.post.update({
        where: { id: postId },
        data: { likesCount: { decrement: 1 } },
      }),
    ])
    const updated = await prisma.post.findUnique({ where: { id: postId }, select: { likesCount: true } })
    return c.json({ liked: false, likesCount: updated?.likesCount ?? 0 })
  } else {
    // Like — create + increment
    await prisma.$transaction([
      prisma.postLike.create({ data: { postId, userId } }),
      prisma.post.update({
        where: { id: postId },
        data: { likesCount: { increment: 1 } },
      }),
    ])
    const updated = await prisma.post.findUnique({ where: { id: postId }, select: { likesCount: true } })
    if (post.authorId !== userId) {
      const liker = await prisma.user.findUnique({ where: { id: userId }, select: { displayName: true } })
      await createNotification({
        userId: post.authorId,
        type: 'post_like',
        title: '新的讚',
        body: `${liker?.displayName ?? '有人'} 按讚了你的貼文`,
        targetType: 'post',
        targetId: postId,
      })
    }
    return c.json({ liked: true, likesCount: updated?.likesCount ?? 0 })
  }
})

// ── POST /posts/:id/comments ───────────────────────────────────────────────────

const createCommentSchema = z.object({
  text: z.string().min(1),
})

posts.post('/:id/comments', authMiddleware, zValidator('json', createCommentSchema), async (c) => {
  const { sub: userId } = c.get('user')
  const postId = c.req.param('id')
  const { text } = c.req.valid('json')

  const post = await prisma.post.findUnique({ where: { id: postId } })
  if (!post) return c.json({ error: '找不到貼文' }, 404)

  const [data] = await prisma.$transaction([
    prisma.comment.create({
      data: { postId, authorId: userId, text },
      include: { author: { select: commentAuthorSelect } },
    }),
    prisma.post.update({
      where: { id: postId },
      data: { commentsCount: { increment: 1 } },
    }),
  ])

  if (post.authorId !== userId) {
    const commenter = await prisma.user.findUnique({ where: { id: userId }, select: { displayName: true } })
    await createNotification({
      userId: post.authorId,
      type: 'post_comment',
      title: '新的留言',
      body: `${commenter?.displayName ?? '有人'} 在你的貼文留言`,
      targetType: 'post',
      targetId: postId,
    })
  }

  return c.json({ data }, 201)
})

// ── GET /posts/:id/comments ────────────────────────────────────────────────────

posts.get('/:id/comments', async (c) => {
  const postId = c.req.param('id')

  const post = await prisma.post.findUnique({ where: { id: postId } })
  if (!post) return c.json({ error: '找不到貼文' }, 404)

  const data = await prisma.comment.findMany({
    where: { postId, deletedAt: null },
    include: { author: { select: commentAuthorSelect } },
    orderBy: { createdAt: 'asc' },
  })

  return c.json({ data })
})

export default posts
