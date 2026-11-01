-- 账号私有创作；所有实体关系都同时约束 owner 与所属创作。
-- 只保存文字、供应商非秘密快照及 COS 元数据，不保存图片字节或 Token 副本。
CREATE TABLE app.creations (
  "ownerId" text NOT NULL REFERENCES app."user"(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 60),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  "nextVersion" integer NOT NULL DEFAULT 1 CHECK ("nextVersion" > 0),
  "createdAt" timestamptz NOT NULL DEFAULT statement_timestamp(),
  "updatedAt" timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY ("ownerId", id)
);

CREATE TABLE app.generation_runs (
  "ownerId" text NOT NULL,
  id uuid NOT NULL,
  "creationId" uuid NOT NULL,
  "clientRequestId" uuid NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  version integer NOT NULL CHECK (version > 0),
  "parentVersionId" uuid,
  status text NOT NULL CHECK (status IN ('preparing','generating','saving','complete','failed','unknown','save_pending')),
  prompt text NOT NULL CHECK (length(prompt) <= 5000),
  "mappingId" text NOT NULL CHECK (length("mappingId") BETWEEN 1 AND 128),
  "modelLabel" text NOT NULL CHECK (length("modelLabel") BETWEEN 1 AND 256),
  "aspectRatio" text NOT NULL CHECK (length("aspectRatio") BETWEEN 1 AND 32),
  quality text NOT NULL CHECK (length(quality) BETWEEN 1 AND 32),
  mode text NOT NULL CHECK (mode IN ('text-to-image','image-editing')),
  "providerBaseUrl" text NOT NULL CHECK (length("providerBaseUrl") BETWEEN 1 AND 2048),
  "providerApiMode" text NOT NULL CHECK ("providerApiMode" IN ('images','chat')),
  "providerModelId" text NOT NULL CHECK (length("providerModelId") BETWEEN 1 AND 256),
  "providerRevision" integer NOT NULL CHECK ("providerRevision" > 0),
  "manifestKey" text NOT NULL CHECK (length("manifestKey") <= 1024),
  "outputKey" text NOT NULL CHECK (length("outputKey") <= 1024),
  "outputAssetId" uuid NOT NULL,
  "failureCode" text CHECK ("failureCode" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  "createdAt" timestamptz NOT NULL DEFAULT statement_timestamp(),
  "updatedAt" timestamptz NOT NULL DEFAULT statement_timestamp(),
  "deadlineAt" timestamptz NOT NULL,
  PRIMARY KEY ("ownerId", id),
  UNIQUE ("ownerId", "clientRequestId"),
  UNIQUE ("ownerId", "creationId", id),
  UNIQUE ("ownerId", "creationId", version),
  UNIQUE ("ownerId", "outputAssetId"),
  FOREIGN KEY ("ownerId", "creationId") REFERENCES app.creations ("ownerId", id) ON DELETE CASCADE,
  FOREIGN KEY ("ownerId", "creationId", "parentVersionId") REFERENCES app.generation_runs ("ownerId", "creationId", id),
  FOREIGN KEY ("ownerId", "clientRequestId") REFERENCES app.provider_request_slots ("userId", "requestId") ON DELETE CASCADE,
  CHECK (id = "clientRequestId"),
  CHECK ("parentVersionId" IS NULL OR "parentVersionId" <> id)
);
CREATE INDEX generation_runs_creation_idx ON app.generation_runs ("ownerId", "creationId", version);

CREATE TABLE app.private_assets (
  "ownerId" text NOT NULL,
  id uuid NOT NULL,
  "creationId" uuid NOT NULL,
  "runId" uuid NOT NULL,
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 1024),
  kind text NOT NULL CHECK (kind IN ('image','document')),
  "mediaType" text NOT NULL CHECK (length("mediaType") BETWEEN 1 AND 128),
  "byteLength" integer NOT NULL CHECK ("byteLength" > 0 AND "byteLength" <= 20971520),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  name text CHECK (length(name) BETWEEN 1 AND 255),
  "createdAt" timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY ("ownerId", id),
  UNIQUE (key),
  FOREIGN KEY ("ownerId", "creationId", "runId") REFERENCES app.generation_runs ("ownerId", "creationId", id) ON DELETE CASCADE
);
CREATE INDEX private_assets_run_idx ON app.private_assets ("ownerId", "runId");
