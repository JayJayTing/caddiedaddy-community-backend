import 'dotenv/config'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import authRoutes from './routes/auth'
import roundRoutes from './routes/rounds'
import communityRoutes from './routes/communities'
import postRoutes from './routes/posts'
import chatRoutes from './routes/chat'
import userRoutes from './routes/users'
import courseRoutes from './routes/courses'
import announcementRoutes from './routes/announcements'
import uploadRoutes from './routes/uploads'
import notificationRoutes from './routes/notifications'
import venueRoutes from './routes/venues'
import bookingRoutes from './routes/bookings'
import merchantRoutes from './routes/merchant'
import creditRoutes from './routes/credits'

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
app.route('/uploads', uploadRoutes)
app.route('/notifications', notificationRoutes)
app.route('/venues', venueRoutes)
app.route('/bookings', bookingRoutes)
app.route('/merchant', merchantRoutes)
app.route('/credits', creditRoutes)

// 404 fallback
app.notFound((c) => c.json({ error: '找不到資源' }, 404))

// Error handler
app.onError((err, c) => {
  // Let intentional HTTP errors (e.g. 409 slot conflict) surface as-is.
  if (err instanceof HTTPException) return err.getResponse()
  console.error(err)
  return c.json({ error: '伺服器發生錯誤' }, 500)
})

const port = parseInt(process.env.PORT ?? '3000', 10)

serve({ fetch: app.fetch, port }, () => {
  console.log(`CaddieDaddy Community API running on port ${port}`)
})
