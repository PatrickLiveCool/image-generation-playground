-- Better Auth 1.7.14: default table/field names + username/admin plugins and
-- server-only temporary credential fields. Every object is explicitly in app;
-- the verified runtime Pool search_path is app,pg_catalog. No runtime DDL.
CREATE TABLE app."user" (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL DEFAULT false,
  image text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  username text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9_-]{3,32}$'),
  "displayUsername" text,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  banned boolean NOT NULL DEFAULT false,
  "banReason" text,
  "banExpires" timestamptz,
  "mustChangePassword" boolean NOT NULL DEFAULT true,
  "temporaryPasswordExpiresAt" timestamptz,
  "temporaryPasswordUsedAt" timestamptz
);
CREATE TABLE app.session (
  id text PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES app."user"(id) ON DELETE CASCADE,
  "impersonatedBy" text
);
CREATE INDEX session_user_id_idx ON app.session ("userId");
CREATE TABLE app.account (
  id text PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES app."user"(id) ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  scope text,
  password text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("providerId", "accountId"),
  UNIQUE ("userId", "providerId")
);
CREATE INDEX account_user_id_idx ON app.account ("userId");
CREATE TABLE app.verification (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_identifier_idx ON app.verification (identifier);
CREATE TABLE app."rateLimit" (
  id text PRIMARY KEY,
  key text NOT NULL UNIQUE,
  count integer NOT NULL,
  "lastRequest" bigint NOT NULL
);
CREATE TABLE app.account_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "actorId" text NOT NULL REFERENCES app."user"(id),
  "subjectId" text NOT NULL REFERENCES app."user"(id),
  action text NOT NULL CHECK (action IN ('bootstrap-admin','create-user','sign-in','sign-out','change-password','disable','restore','reset-password')),
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_audit_created_at_idx ON app.account_audit ("createdAt");
