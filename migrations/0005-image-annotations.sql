-- 旧任务没有批注：保留SQL NULL，不伪造快照或能力证据。
-- 两个真实输入保存成功后才能由应用一次性冻结execution；所有JSON仍由共享纯验证器核验。
ALTER TABLE app.generation_runs
  ADD COLUMN "annotationSnapshot" jsonb CHECK ("annotationSnapshot" IS NULL OR jsonb_typeof("annotationSnapshot") = 'object'),
  ADD COLUMN "annotationExecution" jsonb CHECK ("annotationExecution" IS NULL OR jsonb_typeof("annotationExecution") = 'object'),
  ADD COLUMN "providerAnnotationCapability" jsonb CHECK ("providerAnnotationCapability" IS NULL OR jsonb_typeof("providerAnnotationCapability") = 'object');

-- 能力绑定当前真实配置及管理员证据；已有配置从无已确认能力开始。
ALTER TABLE app.provider_settings
  ADD COLUMN "annotationCapabilities" jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof("annotationCapabilities") = 'array' AND jsonb_array_length("annotationCapabilities") <= 100);
