import 'dotenv/config'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { cors } from 'hono/cors'
import authRoutes from './routes/auth'
import roundRoutes from './routes/rounds'
import communityRoutes from './routes/communities'
import postRoutes from './routes/posts'
import chatRoutes from './routes/chat'
import userRoutes from './routes/users'
import courseRoutes from './routes/courses'
import announcementRoutes from './routes/announcements'

const app = new Hono()

// Middleware
app.use('*', logger())
const allowedOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

app.use('*', cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:3001',
    ...allowedOrigins,
  ],
  credentials: true,
}))

// Health check
app.get('/', (c) => c.json({ ok: true }))

// Routes
app.route('/auth', authRoutes)
app.route('/rounds', roundRoutes)
app.route('/communities', communityRoutes)
app.route('/posts', postRoutes)
app.route('/threads', chatRoutes)
app.route('/users', userRoutes)
app.route('/courses', courseRoutes)
app.route('/announcements', announcementRoutes)

// 404 fallback
app.notFound((c) => c.json({ error: 'Not found' }, 404))

// Error handler
app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'Internal server error' }, 500)
})

const port = parseInt(process.env.PORT ?? '3000', 10)

serve({ fetch: app.fetch, port }, () => {
  console.log(`CaddieDaddy Community API running on port ${port}`)
})
