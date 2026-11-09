-- 删除只关闭创作访问；保留任务、版本、资产引用和 COS 对象，允许原记录撤销恢复。
ALTER TABLE app.creations ADD COLUMN "deletedAt" timestamptz;
