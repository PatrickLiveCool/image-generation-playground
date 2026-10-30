
- source_spec: `spec-00-build-executor.md`
  summary: 上游BMad6.12.0 memlog不支持同workspace并发追加；保持单写者，未来引入并发调用前需复核上游或可信串行边界。
  evidence: 隔离夹具复现两个成功append丢失首条记录；当前无并发memlog消费者，官方原版脚本保持哈希不变。
- source_spec: `spec-00-build-executor.md`
  summary: 上游memlog不拒绝含换行的元数据键；调用方固定ASCII键并仅将用户文本写入value。
  evidence: 审阅临时夹具复现frontmatter异常；当前调用使用topic/scope/purpose/altitude等固定键，README已明确。
