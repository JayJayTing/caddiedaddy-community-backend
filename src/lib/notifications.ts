import { prisma } from './prisma'

type NotifType =
  | 'round_request'
  | 'round_accepted'
  | 'community_invite'
  | 'new_message'
  | 'post_like'
  | 'post_comment'
  | 'round_reminder'

type NotifTarget = 'round' | 'community' | 'post' | 'thread'

// Fire-and-forget notification insert. Never throws — a notification failure must
// not break the user action that triggered it.
export async function createNotification(input: {
  userId: string
  type: NotifType
  title: string
  body: string
  targetType?: NotifTarget
  targetId?: string
}): Promise<void> {
  try {
    await prisma.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
      },
    })
  } catch (err) {
    console.error('[notifications] create failed:', err)
  }
}
