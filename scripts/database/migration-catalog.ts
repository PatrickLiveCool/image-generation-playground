/**
 * 迁移 SQL 是受审阅的项目代码，不是用户输入。只有这里固定的字节能交给数据库。
 * 增加/修改未执行的迁移时，必须审阅整个文件：仅 app 对象，不修改库、角色、
 * 其他 schema/ACL，不执行外部文件、程序或动态 SQL，然后人工更新 SHA-256。
 * 已执行的版本绝不可改写。不能用自动生成清单或正则检查替代这项审阅。
 */
export const approvedMigrations: Readonly<Record<string, string>> = Object.freeze({
  "0001-accounts.sql": "21d4c583ea7974706abde98a730f95146069324bc2814946e3763e7634a69064",
})
