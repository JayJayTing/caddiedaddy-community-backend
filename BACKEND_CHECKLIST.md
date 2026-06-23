# CaddieDaddy Community — Backend Implementation Checklist

> Run `npm run checklist:sync` from the `backend/` directory to auto-update checkboxes.
> **Last synced:** 2026-06-23 19:19:19 UTC
> **Progress:** 8 / 62 routes implemented

---

## Auth (`src/routes/auth.ts`)

- [x] Email signup <!-- sync: auth.post('/signup', -->
- [x] Email login <!-- sync: auth.post('/login', -->
- [x] Email logout <!-- sync: auth.post('/logout', -->
- [x] Phone OTP — send code <!-- sync: auth.post('/phone/send-otp', -->
- [x] Phone OTP — verify code <!-- sync: auth.post('/verify-otp', -->
- [ ] Apple OAuth — get redirect URL <!-- sync: auth.get('/apple/url', -->
- [ ] Apple OAuth — exchange code for session <!-- sync: auth.post('/apple/callback', -->
- [x] Google OAuth — get redirect URL <!-- sync: auth.get('/google/url', -->
- [x] Google OAuth — exchange code for session <!-- sync: auth.post('/google/callback', -->
- [x] Get current user profile (`/auth/me`) <!-- sync: auth.get('/me', -->

---

## User Profile (`src/routes/users.ts`)

- [ ] Update profile (display name, bio, location, avatar) <!-- sync: users.put('/me', -->
- [ ] Get user stats (rounds played, handicap, following count) <!-- sync: users.get('/me/stats', -->
- [ ] Get handicap history <!-- sync: users.get('/me/handicap', -->
- [ ] Update notification preferences <!-- sync: users.put('/me/notifications', -->
- [ ] Set home course <!-- sync: users.put('/me/home-course', -->

---

## Courses (`src/routes/courses.ts`)

- [ ] Search courses by name <!-- sync: courses.get('/search', -->
- [ ] Get all courses with coordinates (for map) <!-- sync: courses.get('/', -->
- [ ] Get available tee times at a course <!-- sync: courses.get('/:id/tee-times', -->

---

## Rounds (`src/routes/rounds.ts`)

- [ ] Create a round (host) <!-- sync: rounds.post('/', -->
- [ ] Search / list rounds with filters (date, time, format, handicap, holes, community) <!-- sync: rounds.get('/search', -->
- [ ] Get round detail <!-- sync: rounds.get('/:id', -->
- [ ] Get players joined in a round <!-- sync: rounds.get('/:id/players', -->
- [ ] Request to join a round <!-- sync: rounds.post('/:id/request', -->
- [ ] Accept / decline a join request (host only) <!-- sync: rounds.patch('/:id/request/:userId', -->
- [ ] Cancel a round (host only) <!-- sync: rounds.delete('/:id', -->
- [ ] Get user's upcoming rounds (for Home "next round" card) <!-- sync: rounds.get('/mine', -->

---

## Communities (`src/routes/communities.ts`)

- [ ] Create a community <!-- sync: communities.post('/', -->
- [ ] Discover communities (public list + search) <!-- sync: communities.get('/discover', -->
- [ ] Get communities the user has joined <!-- sync: communities.get('/following', -->
- [ ] Get communities the user owns / leads <!-- sync: communities.get('/mine', -->
- [ ] Get community detail <!-- sync: communities.get('/:id', -->
- [ ] Join a community <!-- sync: communities.post('/:id/join', -->
- [ ] Leave a community <!-- sync: communities.delete('/:id/leave', -->
- [ ] Get community members list <!-- sync: communities.get('/:id/members', -->
- [ ] Get rounds in a community <!-- sync: communities.get('/:id/rounds', -->

---

## Posts & Feed (`src/routes/posts.ts`)

- [ ] Create a post (text, photo, LFP, round report) <!-- sync: posts.post('/', -->
- [ ] List posts (by community, by type, public feed) <!-- sync: posts.get('/', -->
- [ ] Get post detail with comments <!-- sync: posts.get('/:id', -->
- [ ] Like / unlike a post <!-- sync: posts.post('/:id/like', -->
- [ ] Comment on a post <!-- sync: posts.post('/:id/comment', -->
- [ ] Delete a post (author or community admin) <!-- sync: posts.delete('/:id', -->
- [ ] Pin post as announcement (admin only) <!-- sync: posts.patch('/:id/pin', -->
- [ ] Get comments for a post <!-- sync: posts.get('/:id/comments', -->

---

## Chat & Messaging (`src/routes/chat.ts`)

- [ ] Get conversation list (DMs + community chats) <!-- sync: chat.get('/conversations', -->
- [ ] Get thread message history <!-- sync: chat.get('/:threadId/messages', -->
- [ ] Send a message <!-- sync: chat.post('/:threadId/messages', -->
- [ ] Start a new DM thread <!-- sync: chat.post('/threads', -->
- [ ] Get total unread count <!-- sync: chat.get('/unread', -->

---

## Social Connections (`src/routes/connections.ts`)

- [ ] Discover / search players <!-- sync: connections.get('/discover', -->
- [ ] Send a friend request <!-- sync: connections.post('/request', -->
- [ ] Accept / decline a friend request <!-- sync: connections.patch('/request/:id', -->
- [ ] List friends / connections <!-- sync: connections.get('/', -->

---

## News & Announcements (`src/routes/news.ts`)

- [ ] List announcements <!-- sync: news.get('/', -->
- [ ] Get announcement detail <!-- sync: news.get('/:id', -->
- [ ] Create announcement (admin only) <!-- sync: news.post('/', -->

---

## Moderation (`src/routes/moderation.ts`)

- [ ] Warn a community member <!-- sync: moderation.post('/warn', -->
- [ ] Remove a post from a community <!-- sync: moderation.delete('/post/:id', -->
- [ ] Kick a member from a community <!-- sync: moderation.post('/kick', -->
- [ ] Block a member from a community <!-- sync: moderation.post('/block', -->

---

## Notifications (`src/routes/notifications.ts`)

- [ ] List notifications for current user <!-- sync: notifications.get('/', -->
- [ ] Mark notifications as read <!-- sync: notifications.patch('/read', -->
- [ ] Get notification preferences <!-- sync: notifications.get('/preferences', -->
