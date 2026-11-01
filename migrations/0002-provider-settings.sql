-- 单套连接配置；Token 仅保存有版本及认证标签的加密 envelope。
CREATE TABLE app.provider_settings (
  singleton smallint PRIMARY KEY CHECK (singleton = 1),
  "baseUrl" text NOT NULL CHECK (length("baseUrl") BETWEEN 1 AND 2048),
  "tokenCiphertext" text NOT NULL CHECK (length("tokenCiphertext") BETWEEN 1 AND 24000),
  "apiMode" text NOT NULL CHECK ("apiMode" IN ('images', 'chat')),
  models jsonb NOT NULL CHECK (jsonb_typeof(models) = 'array' AND jsonb_array_length(models) <= 5000),
  mappings jsonb NOT NULL CHECK (jsonb_typeof(mappings) = 'array' AND jsonb_array_length(mappings) <= 100),
  "modelsSynced" boolean NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  "updatedBy" text NOT NULL REFERENCES app."user"(id),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

-- 不改变已执行的账号审计约束，也不记录连接地址、Token 或模型正文。
CREATE TABLE app.provider_config_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "actorId" text NOT NULL REFERENCES app."user"(id),
  revision integer NOT NULL CHECK (revision > 0),
  action text NOT NULL CHECK (action = 'save'),
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
