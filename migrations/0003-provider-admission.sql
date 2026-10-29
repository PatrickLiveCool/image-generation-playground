-- 短时调用保护与幂等键；仅保存请求摘要，不记录秘密、图片或计费数据。
-- 不删除到期幂等键：deadline 只释放并发占位，同一请求永远不能重新受理。
CREATE TABLE app.provider_request_slots (
  "userId" text NOT NULL REFERENCES app."user"(id) ON DELETE CASCADE,
  "requestId" uuid NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','finished','unknown')),
  "acceptedAt" timestamptz NOT NULL DEFAULT statement_timestamp(),
  "deadlineAt" timestamptz NOT NULL DEFAULT statement_timestamp() + interval '300 seconds',
  PRIMARY KEY ("userId", "requestId"),
  CHECK ("deadlineAt" = "acceptedAt" + interval '300 seconds')
);
CREATE INDEX provider_request_slots_active_deadline_idx
  ON app.provider_request_slots ("deadlineAt") WHERE status IN ('active','unknown');
CREATE INDEX provider_request_slots_user_accepted_idx
  ON app.provider_request_slots ("userId", "acceptedAt");
