-- CaddieDaddy Community — Initial Schema
-- Generated from Prisma schema

-- ==================
-- EXTENSIONS
-- ==================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ==================
-- ENUMS
-- ==================

CREATE TYPE "AuthMethod" AS ENUM ('phone', 'email', 'apple', 'google');
CREATE TYPE "VenueType" AS ENUM ('course', 'driving_range');
CREATE TYPE "RoundFormat" AS ENUM ('stroke_play', 'stableford', 'best_ball', 'scramble');
CREATE TYPE "HandicapRequirement" AS ENUM ('all', 'u10', 'u15', 'u20', 'u28');
CREATE TYPE "RoundVisibility" AS ENUM ('public', 'community');
CREATE TYPE "RoundStatus" AS ENUM ('open', 'full', 'cancelled', 'completed');
CREATE TYPE "ParticipantRole" AS ENUM ('host', 'accepted', 'requested', 'declined', 'waitlisted');
CREATE TYPE "CommunityType" AS ENUM ('mixed', 'mens_club', 'ladies_club', 'corporate', 'beginner');
CREATE TYPE "CommunityPrivacy" AS ENUM ('public', 'invite_only', 'private');
CREATE TYPE "CommunityMemberRole" AS ENUM ('admin', 'leader', 'member');
CREATE TYPE "CommunityMemberStatus" AS ENUM ('active', 'invited', 'banned');
CREATE TYPE "InviteStatus" AS ENUM ('pending', 'accepted', 'expired', 'revoked');
CREATE TYPE "PostType" AS ENUM ('round_report', 'seeking', 'tip', 'general', 'announcement');
CREATE TYPE "PostVisibility" AS ENUM ('public', 'community');
CREATE TYPE "PostStatus" AS ENUM ('active', 'removed', 'flagged');
CREATE TYPE "ConnectionStatus" AS ENUM ('pending', 'accepted', 'declined', 'blocked');
CREATE TYPE "ThreadType" AS ENUM ('dm', 'group');
CREATE TYPE "NotificationType" AS ENUM ('round_request', 'round_accepted', 'community_invite', 'new_message', 'post_like', 'post_comment', 'round_reminder');
CREATE TYPE "NotificationTargetType" AS ENUM ('round', 'community', 'post', 'thread');
CREATE TYPE "ModerationAction" AS ENUM ('warn', 'kick', 'block', 'post_removed', 'post_flagged');

-- ==================
-- COURSES (no FK deps)
-- ==================

CREATE TABLE "courses" (
  "id"            UUID         NOT NULL DEFAULT gen_random_uuid(),
  "name"          VARCHAR(100) NOT NULL,
  "location_text" VARCHAR(80),
  "district"      VARCHAR(40),
  "city"          VARCHAR(40),
  "country"       CHAR(2)      NOT NULL DEFAULT 'TW',
  "lat"           DECIMAL(9,6),
  "lng"           DECIMAL(9,6),
  "hole_count"    INT          NOT NULL DEFAULT 18,
  "created_at"    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_courses_name" ON "courses" ("name");

-- ==================
-- USERS
-- ==================

CREATE TABLE "users" (
  "id"              UUID        NOT NULL DEFAULT gen_random_uuid(),
  "display_name"    VARCHAR(80) NOT NULL,
  "avatar_url"      TEXT,
  "avatar_initial"  CHAR(1),
  "bio"             TEXT,
  "location_text"   VARCHAR(80),
  "home_course_id"  UUID        REFERENCES "courses"("id") ON DELETE SET NULL,
  "handicap_index"  DECIMAL(4,1),
  "member_since"    DATE,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deleted_at"      TIMESTAMPTZ,
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_users_home_course" ON "users" ("home_course_id");
CREATE INDEX "idx_users_deleted_at"  ON "users" ("deleted_at");

-- ==================
-- USER AUTH METHODS
-- ==================

CREATE TABLE "user_auth_methods" (
  "id"          UUID        NOT NULL DEFAULT gen_random_uuid(),
  "user_id"     UUID        NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "method"      "AuthMethod" NOT NULL,
  "credential"  TEXT        NOT NULL,
  "verified_at" TIMESTAMPTZ,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "user_auth_methods_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_auth_methods_method_credential_key" UNIQUE ("method", "credential")
);

CREATE INDEX "idx_auth_methods_user" ON "user_auth_methods" ("user_id");

-- ==================
-- COMMUNITIES
-- ==================

CREATE TABLE "communities" (
  "id"              UUID              NOT NULL DEFAULT gen_random_uuid(),
  "creator_id"      UUID              NOT NULL REFERENCES "users"("id"),
  "name"            VARCHAR(80)       NOT NULL,
  "type"            "CommunityType"   NOT NULL DEFAULT 'mixed',
  "home_course_id"  UUID              REFERENCES "courses"("id") ON DELETE SET NULL,
  "privacy"         "CommunityPrivacy" NOT NULL DEFAULT 'public',
  "description"     TEXT,
  "color1"          VARCHAR(20),
  "color2"          VARCHAR(20),
  "logo_url"        TEXT,
  "member_count"    INT               NOT NULL DEFAULT 1,
  "post_count"      INT               NOT NULL DEFAULT 0,
  "round_count"     INT               NOT NULL DEFAULT 0,
  "created_at"      TIMESTAMPTZ       NOT NULL DEFAULT now(),
  "updated_at"      TIMESTAMPTZ       NOT NULL DEFAULT now(),
  "deleted_at"      TIMESTAMPTZ,
  CONSTRAINT "communities_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_communities_creator"    ON "communities" ("creator_id");
CREATE INDEX "idx_communities_home_course" ON "communities" ("home_course_id");
CREATE INDEX "idx_communities_deleted_at" ON "communities" ("deleted_at");

-- ==================
-- ROUNDS
-- ==================

CREATE TABLE "rounds" (
  "id"                   UUID                  NOT NULL DEFAULT gen_random_uuid(),
  "host_user_id"         UUID                  NOT NULL REFERENCES "users"("id"),
  "course_id"            UUID                  NOT NULL REFERENCES "courses"("id"),
  "date"                 DATE                  NOT NULL,
  "tee_time"             TIME                  NOT NULL,
  "venue_type"           "VenueType"           NOT NULL DEFAULT 'course',
  "format"               "RoundFormat"         NOT NULL,
  "holes"                INT                   NOT NULL DEFAULT 18,
  "total_spots"          INT                   NOT NULL,
  "green_fee_cents"      INT,
  "handicap_requirement" "HandicapRequirement" NOT NULL DEFAULT 'all',
  "visibility"           "RoundVisibility"     NOT NULL DEFAULT 'public',
  "community_id"         UUID                  REFERENCES "communities"("id") ON DELETE SET NULL,
  "notes"                TEXT,
  "color1"               VARCHAR(20),
  "color2"               VARCHAR(20),
  "status"               "RoundStatus"         NOT NULL DEFAULT 'open',
  "created_at"           TIMESTAMPTZ           NOT NULL DEFAULT now(),
  "updated_at"           TIMESTAMPTZ           NOT NULL DEFAULT now(),
  CONSTRAINT "rounds_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "rounds_holes_check" CHECK ("holes" IN (9, 18)),
  CONSTRAINT "rounds_total_spots_check" CHECK ("total_spots" BETWEEN 2 AND 4)
);

CREATE INDEX "idx_rounds_date_status" ON "rounds" ("date", "status");
CREATE INDEX "idx_rounds_host"        ON "rounds" ("host_user_id");
CREATE INDEX "idx_rounds_community"   ON "rounds" ("community_id") WHERE "community_id" IS NOT NULL;
CREATE INDEX "idx_rounds_course"      ON "rounds" ("course_id");

-- ==================
-- ROUND PARTICIPANTS
-- ==================

CREATE TABLE "round_participants" (
  "id"        UUID             NOT NULL DEFAULT gen_random_uuid(),
  "round_id"  UUID             NOT NULL REFERENCES "rounds"("id") ON DELETE CASCADE,
  "user_id"   UUID             NOT NULL REFERENCES "users"("id"),
  "role"      "ParticipantRole" NOT NULL,
  "joined_at" TIMESTAMPTZ      NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ     NOT NULL DEFAULT now(),
  CONSTRAINT "round_participants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "round_participants_round_user_key" UNIQUE ("round_id", "user_id")
);

CREATE INDEX "idx_rp_user"  ON "round_participants" ("user_id", "role");
CREATE INDEX "idx_rp_round" ON "round_participants" ("round_id", "role");

-- ==================
-- COMMUNITY MEMBERS
-- ==================

CREATE TABLE "community_members" (
  "id"           UUID                   NOT NULL DEFAULT gen_random_uuid(),
  "community_id" UUID                   NOT NULL REFERENCES "communities"("id") ON DELETE CASCADE,
  "user_id"      UUID                   NOT NULL REFERENCES "users"("id"),
  "role"         "CommunityMemberRole"  NOT NULL DEFAULT 'member',
  "status"       "CommunityMemberStatus" NOT NULL DEFAULT 'active',
  "joined_at"    TIMESTAMPTZ            NOT NULL DEFAULT now(),
  "updated_at"   TIMESTAMPTZ            NOT NULL DEFAULT now(),
  CONSTRAINT "community_members_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "community_members_community_user_key" UNIQUE ("community_id", "user_id")
);

CREATE INDEX "idx_cm_user"           ON "community_members" ("user_id", "status");
CREATE INDEX "idx_cm_community_role" ON "community_members" ("community_id", "role");

-- ==================
-- COMMUNITY INVITES
-- ==================

CREATE TABLE "community_invites" (
  "id"            UUID          NOT NULL DEFAULT gen_random_uuid(),
  "community_id"  UUID          NOT NULL REFERENCES "communities"("id") ON DELETE CASCADE,
  "inviter_id"    UUID          NOT NULL REFERENCES "users"("id"),
  "invitee_email" TEXT,
  "invitee_phone" TEXT,
  "token"         VARCHAR(64)   NOT NULL,
  "status"        "InviteStatus" NOT NULL DEFAULT 'pending',
  "expires_at"    TIMESTAMPTZ   NOT NULL,
  "created_at"    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT "community_invites_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "community_invites_token_key" UNIQUE ("token")
);

CREATE INDEX "idx_invites_community" ON "community_invites" ("community_id");
CREATE INDEX "idx_invites_token"     ON "community_invites" ("token");

-- ==================
-- POSTS
-- ==================

CREATE TABLE "posts" (
  "id"                  UUID             NOT NULL DEFAULT gen_random_uuid(),
  "author_id"           UUID             NOT NULL REFERENCES "users"("id"),
  "type"                "PostType"       NOT NULL DEFAULT 'general',
  "body"                TEXT             NOT NULL,
  "location_text"       VARCHAR(80),
  "location_course_id"  UUID             REFERENCES "courses"("id") ON DELETE SET NULL,
  "photo_url"           TEXT,
  "visibility"          "PostVisibility" NOT NULL DEFAULT 'public',
  "is_pinned"           BOOLEAN          NOT NULL DEFAULT FALSE,
  "is_lfp"              BOOLEAN          NOT NULL DEFAULT FALSE,
  "lfp_players_needed"  INT,
  "likes_count"         INT              NOT NULL DEFAULT 0,
  "comments_count"      INT              NOT NULL DEFAULT 0,
  "status"              "PostStatus"     NOT NULL DEFAULT 'active',
  "created_at"          TIMESTAMPTZ      NOT NULL DEFAULT now(),
  "updated_at"          TIMESTAMPTZ      NOT NULL DEFAULT now(),
  "deleted_at"          TIMESTAMPTZ,
  CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_posts_author"     ON "posts" ("author_id");
CREATE INDEX "idx_posts_created"    ON "posts" ("created_at" DESC) WHERE "deleted_at" IS NULL;
CREATE INDEX "idx_posts_status"     ON "posts" ("status", "deleted_at");

-- ==================
-- POST COMMUNITIES (junction)
-- ==================

CREATE TABLE "post_communities" (
  "post_id"      UUID NOT NULL REFERENCES "posts"("id") ON DELETE CASCADE,
  "community_id" UUID NOT NULL REFERENCES "communities"("id") ON DELETE CASCADE,
  CONSTRAINT "post_communities_pkey" PRIMARY KEY ("post_id", "community_id")
);

CREATE INDEX "idx_post_communities_community" ON "post_communities" ("community_id");

-- ==================
-- POST SCORECARDS
-- ==================

CREATE TABLE "post_scorecards" (
  "id"           UUID        NOT NULL DEFAULT gen_random_uuid(),
  "post_id"      UUID        NOT NULL REFERENCES "posts"("id") ON DELETE CASCADE,
  "course_id"    UUID        REFERENCES "courses"("id") ON DELETE SET NULL,
  "label"        VARCHAR(40) NOT NULL,
  "scores"       INT[]       NOT NULL,
  "gross_total"  INT         NOT NULL,
  "holes_played" INT         NOT NULL,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "post_scorecards_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "post_scorecards_post_id_key" UNIQUE ("post_id"),
  CONSTRAINT "post_scorecards_holes_check" CHECK ("holes_played" IN (9, 18))
);

CREATE INDEX "idx_scorecards_course" ON "post_scorecards" ("course_id");

-- ==================
-- POST ROUND LINKS (junction)
-- ==================

CREATE TABLE "post_round_links" (
  "post_id"  UUID NOT NULL REFERENCES "posts"("id") ON DELETE CASCADE,
  "round_id" UUID NOT NULL REFERENCES "rounds"("id") ON DELETE CASCADE,
  CONSTRAINT "post_round_links_pkey" PRIMARY KEY ("post_id", "round_id")
);

-- ==================
-- POST LIKES
-- ==================

CREATE TABLE "post_likes" (
  "post_id"    UUID        NOT NULL REFERENCES "posts"("id") ON DELETE CASCADE,
  "user_id"    UUID        NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "post_likes_pkey" PRIMARY KEY ("post_id", "user_id")
);

CREATE INDEX "idx_post_likes_user" ON "post_likes" ("user_id");

-- ==================
-- COMMENTS
-- ==================

CREATE TABLE "comments" (
  "id"         UUID        NOT NULL DEFAULT gen_random_uuid(),
  "post_id"    UUID        NOT NULL REFERENCES "posts"("id") ON DELETE CASCADE,
  "author_id"  UUID        NOT NULL REFERENCES "users"("id"),
  "text"       TEXT        NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deleted_at" TIMESTAMPTZ,
  CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_comments_post"   ON "comments" ("post_id", "created_at" ASC);
CREATE INDEX "idx_comments_author" ON "comments" ("author_id");

-- ==================
-- USER CONNECTIONS
-- ==================

CREATE TABLE "user_connections" (
  "id"           UUID               NOT NULL DEFAULT gen_random_uuid(),
  "initiator_id" UUID               NOT NULL REFERENCES "users"("id"),
  "recipient_id" UUID               NOT NULL REFERENCES "users"("id"),
  "status"       "ConnectionStatus" NOT NULL DEFAULT 'pending',
  "initiated_at" TIMESTAMPTZ        NOT NULL DEFAULT now(),
  "updated_at"   TIMESTAMPTZ        NOT NULL DEFAULT now(),
  CONSTRAINT "user_connections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_connections_initiator_recipient_key" UNIQUE ("initiator_id", "recipient_id")
);

CREATE INDEX "idx_uc_recipient" ON "user_connections" ("recipient_id", "status");
CREATE INDEX "idx_uc_initiator" ON "user_connections" ("initiator_id", "status");

-- ==================
-- CHAT THREADS
-- ==================

CREATE TABLE "chat_threads" (
  "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
  "type"            "ThreadType" NOT NULL DEFAULT 'dm',
  "community_id"    UUID         REFERENCES "communities"("id") ON DELETE SET NULL,
  "name"            VARCHAR(80),
  "last_message_at" TIMESTAMPTZ,
  "created_at"      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT "chat_threads_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_threads_last_msg"  ON "chat_threads" ("last_message_at" DESC);
CREATE INDEX "idx_threads_community" ON "chat_threads" ("community_id");

-- ==================
-- THREAD PARTICIPANTS
-- ==================

CREATE TABLE "thread_participants" (
  "thread_id"   UUID        NOT NULL REFERENCES "chat_threads"("id") ON DELETE CASCADE,
  "user_id"     UUID        NOT NULL REFERENCES "users"("id"),
  "last_read_at" TIMESTAMPTZ,
  "joined_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "left_at"     TIMESTAMPTZ,
  "is_muted"    BOOLEAN     NOT NULL DEFAULT FALSE,
  CONSTRAINT "thread_participants_pkey" PRIMARY KEY ("thread_id", "user_id")
);

CREATE INDEX "idx_thread_participants_user" ON "thread_participants" ("user_id");

-- ==================
-- MESSAGES
-- ==================

CREATE TABLE "messages" (
  "id"         UUID        NOT NULL DEFAULT gen_random_uuid(),
  "thread_id"  UUID        NOT NULL REFERENCES "chat_threads"("id") ON DELETE CASCADE,
  "sender_id"  UUID        NOT NULL REFERENCES "users"("id"),
  "text"       TEXT        NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "edited_at"  TIMESTAMPTZ,
  "deleted_at" TIMESTAMPTZ,
  CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_messages_thread" ON "messages" ("thread_id", "created_at" DESC) WHERE "deleted_at" IS NULL;
CREATE INDEX "idx_messages_sender" ON "messages" ("sender_id");

-- ==================
-- NOTIFICATIONS
-- ==================

CREATE TABLE "notifications" (
  "id"          UUID                     NOT NULL DEFAULT gen_random_uuid(),
  "user_id"     UUID                     NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "type"        "NotificationType"       NOT NULL,
  "title"       VARCHAR(120)             NOT NULL,
  "body"        TEXT                     NOT NULL,
  "target_type" "NotificationTargetType",
  "target_id"   UUID,
  "read_at"     TIMESTAMPTZ,
  "created_at"  TIMESTAMPTZ              NOT NULL DEFAULT now(),
  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_notifications_user_unread" ON "notifications" ("user_id", "created_at" DESC) WHERE "read_at" IS NULL;

-- ==================
-- USER NOTIFICATION PREFS
-- ==================

CREATE TABLE "user_notification_prefs" (
  "user_id"             UUID    NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "rounds_nearby"       BOOLEAN NOT NULL DEFAULT TRUE,
  "community_activity"  BOOLEAN NOT NULL DEFAULT TRUE,
  "round_reminders"     BOOLEAN NOT NULL DEFAULT TRUE,
  "new_messages"        BOOLEAN NOT NULL DEFAULT TRUE,
  "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "user_notification_prefs_pkey" PRIMARY KEY ("user_id")
);

-- ==================
-- ANNOUNCEMENTS
-- ==================

CREATE TABLE "announcements" (
  "id"           UUID        NOT NULL DEFAULT gen_random_uuid(),
  "author_id"    UUID        NOT NULL REFERENCES "users"("id"),
  "badge"        VARCHAR(40) NOT NULL,
  "title"        VARCHAR(120) NOT NULL,
  "body"         TEXT        NOT NULL,
  "published_at" TIMESTAMPTZ NOT NULL,
  "expires_at"   TIMESTAMPTZ,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_announcements_published" ON "announcements" ("published_at" DESC);
CREATE INDEX "idx_announcements_expires"   ON "announcements" ("expires_at");

-- ==================
-- MODERATION LOG
-- ==================

CREATE TABLE "moderation_actions" (
  "id"              UUID               NOT NULL DEFAULT gen_random_uuid(),
  "moderator_id"    UUID               NOT NULL REFERENCES "users"("id"),
  "community_id"    UUID               NOT NULL REFERENCES "communities"("id"),
  "target_user_id"  UUID               NOT NULL REFERENCES "users"("id"),
  "action"          "ModerationAction" NOT NULL,
  "target_post_id"  UUID               REFERENCES "posts"("id") ON DELETE SET NULL,
  "reason"          TEXT,
  "created_at"      TIMESTAMPTZ        NOT NULL DEFAULT now(),
  CONSTRAINT "moderation_actions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_mod_community" ON "moderation_actions" ("community_id", "created_at" DESC);
CREATE INDEX "idx_mod_target"    ON "moderation_actions" ("target_user_id");
CREATE INDEX "idx_mod_moderator" ON "moderation_actions" ("moderator_id");

-- ==================
-- HANDICAP HISTORY
-- ==================

CREATE TABLE "handicap_history" (
  "id"              UUID        NOT NULL DEFAULT gen_random_uuid(),
  "user_id"         UUID        NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "handicap_index"  DECIMAL(4,1) NOT NULL,
  "recorded_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "handicap_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_handicap_user" ON "handicap_history" ("user_id", "recorded_at" DESC);

-- ==================
-- SEED: 6 courses from prototype
-- ==================

INSERT INTO "courses" ("id", "name", "location_text", "district", "city", "lat", "lng", "hole_count") VALUES
  (gen_random_uuid(), 'Dragon Valley GC',      'Longtan, Taoyuan',  'Longtan',  'Taoyuan', 24.8589, 121.2128, 18),
  (gen_random_uuid(), 'Sunrise Golf Club',     'Yangmei, Taoyuan',  'Yangmei',  'Taoyuan', 24.9312, 121.2285, 18),
  (gen_random_uuid(), 'Yangmei Country Club',  'Yangmei, Taoyuan',  'Yangmei',  'Taoyuan', 24.9187, 121.2354, 18),
  (gen_random_uuid(), 'Breeze Links',          'Zhongli, Taoyuan',  'Zhongli',  'Taoyuan', 24.9654, 121.2142, 18),
  (gen_random_uuid(), 'Tianmu Golf Club',      'Shilin, Taipei',    'Shilin',   'Taipei',  25.1104, 121.5247, 18),
  (gen_random_uuid(), 'Taoyuan Golf & CC',     'Taoyuan',           'Taoyuan',  'Taoyuan', 24.9876, 121.3524, 18);
