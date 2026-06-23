import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import authRoutes from './routes/auth'

const app = new Hono()

// Middleware
app.use('*', logger())

// Health check
app.get('/', (c) => c.json({ ok: true }))

// Routes
app.route('/auth', authRoutes)

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
