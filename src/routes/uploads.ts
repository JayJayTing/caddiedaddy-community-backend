import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { prisma } from '../lib/prisma'
import { authMiddleware } from '../middleware/auth'
import { uploadImage, UploadError } from '../lib/storage'

const uploads = new Hono()

// Shared user select (mirrors PATCH /users/me so the client can reuse it).
const userSelect = {
  id: true,
  displayName: true,
  avatarInitial: true,
  avatarUrl: true,
  bio: true,
  locationText: true,
  handicapIndex: true,
  memberSince: true,
  homeCourse: { select: { id: true, name: true, locationText: true } },
} as const

function getFile(body: Record<string, unknown>): File {
  const f = body['file']
  if (!(f instanceof File)) throw new UploadError(400, '未提供檔案（欄位 "file"）')
  return f
}

function fail(c: { json: (o: unknown, s: ContentfulStatusCode) => Response }, e: unknown) {
  if (e instanceof UploadError) return c.json({ error: e.message }, e.status as ContentfulStatusCode)
  throw e
}

// ── POST /uploads/avatar ───────────────────────────────────────────────────────
// Uploads the current user's avatar and returns the updated user record.

uploads.post('/avatar', authMiddleware, async (c) => {
  const { sub: userId } = c.get('user')
  try {
    const file = getFile(await c.req.parseBody())
    const url = await uploadImage('avatars', userId, file)
    const data = await prisma.user.update({ where: { id: userId }, data: { avatarUrl: url }, select: userSelect })
    return c.json({ data })
  } catch (e) {
    return fail(c, e)
  }
})

// ── POST /uploads/post ─────────────────────────────────────────────────────────
// Uploads a post image and returns its URL; the client passes it as `photoUrl`
// when creating the post (POST /posts).

uploads.post('/post', authMiddleware, async (c) => {
  const { sub: userId } = c.get('user')
  try {
    const file = getFile(await c.req.parseBody())
    const url = await uploadImage('posts', userId, file)
    return c.json({ data: { url } })
  } catch (e) {
    return fail(c, e)
  }
})

// ── POST /uploads/course ───────────────────────────────────────────────────────
// Uploads a course/venue photo and returns its URL; the client passes the url(s)
// as coverPhotoUrl / photos when submitting a course (POST /courses). Keyed by the
// submitting user since the course row doesn't exist yet (upload-then-create).

uploads.post('/course', authMiddleware, async (c) => {
  const { sub: userId } = c.get('user')
  try {
    const file = getFile(await c.req.parseBody())
    const url = await uploadImage('courses', userId, file)
    return c.json({ data: { url } })
  } catch (e) {
    return fail(c, e)
  }
})

// ── POST /uploads/community/:id ────────────────────────────────────────────────
// Uploads community art (creator or admin only) and returns the updated community.

uploads.post('/community/:id', authMiddleware, async (c) => {
  const { sub: userId } = c.get('user')
  const id = c.req.param('id')
  try {
    const community = await prisma.community.findUnique({
      where: { id },
      select: { id: true, creatorId: true, deletedAt: true },
    })
    if (!community || community.deletedAt) return c.json({ error: '找不到社群' }, 404)

    let allowed = community.creatorId === userId
    if (!allowed) {
      const member = await prisma.communityMember.findUnique({
        where: { communityId_userId: { communityId: id, userId } },
      })
      allowed = member?.role === 'admin'
    }
    if (!allowed) return c.json({ error: '只有社群管理員可以變更社群封面' }, 403)

    const file = getFile(await c.req.parseBody())
    const url = await uploadImage('communities', id, file)
    const data = await prisma.community.update({ where: { id }, data: { logoUrl: url } })
    return c.json({ data })
  } catch (e) {
    return fail(c, e)
  }
})

export default uploads
