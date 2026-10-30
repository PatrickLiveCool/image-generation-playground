# 批注共享实现契约

父规格：[图片区域批注与统一提交](spec-05-image-annotations.md)。此文件记录接口与工作边界，不改变已确认的用户目标。

## 共享纯模块（主代理）

lib/image-annotations.ts不引入Node、sharp、数据库。导出：

- AnnotationPoint={x:number,y:number}。
- AnnotationImageMetadata={assetId:string,width:number,height:number,orientation:number,pages:number}，宽高为原始编码像素；AnnotationImage将pages收窄为1。
- AnnotationMark={id:string,number:number,instruction:string,geometry}。geometry为{type:"rectangle",x,y,width,height}、{type:"lasso",points:AnnotationPoint[]}或{type:"brush",points:AnnotationPoint[],brushWidth:number}。
- AnnotationSnapshot={schema:1,coordinateSpace:"encoded-pixels-v1",baseVersionId:string,image:AnnotationImage,marks:AnnotationMark[]}。
- AnnotationDraft={snapshot:AnnotationSnapshot,revision:number,nextNumber:number}；CreationDraft.annotationDrafts按baseVersionId存储，可为空。
- validateAnnotationSnapshot(value,{allowIncomplete?:boolean})返回规范化深拷贝，抛AnnotationValidationError；允许不完整仅用于草稿空说明/零标记，提交须全部有效。
- serializeAnnotationSnapshot(snapshot)、createEmptyAnnotationSnapshot(baseVersionId,image)、orientedImageSize(image)、toDisplayPoint(point,image)、toEncodedPoint(point,image)、annotationMarkBounds(mark)、annotationDisplayBounds(mark,image)、composeAnnotatedPrompt(overall,snapshot)。

UUID/编号稳定，删除不重排编号；数值有限且最多2位小数，坐标位于原图连续边界[0,width]×[0,height]，矩形正面积，lasso至少3点/非零范围，brush至少1点/正笔宽。20条、单路径256点、总4096点、单说明500字、JSON128KiB；组合提示词仍5000字。非法不丢弃或截断。所有8个EXIF方向可逆，5–8交换展示宽高。快照固定assetId，不接受客户端owner/对象键/服务商设置。

lib/annotation-renderer.ts（主代理）导出renderAnnotationOverlay(original:ValidatedPrivateImage,snapshot):Promise<ImageBytes>；校验真实宽高/方向/单帧，原字节不变，仅辅助图autoOrient。生成带数字和三种区域线条的PNG；超过10MiB时尝试同尺寸JPEG编码，仅内存；最大16M像素并在输入/COS上限内。

## 配置能力（provider工作包）

provider_settings.annotationCapabilities为jsonb非空数组，默认[]。新增独立管理员动作，提交expected revision、mappingId、HTTPS evidenceReference、evidenceNote并确认当前连接支持原图+标注图两输入；记录actor/time/evidenceID。该动作不调用模型，不将记录称作真实效果验收。

新lib/annotation-capability.ts存共享类型/纯形状校验。能力绑定baseUrl/apiMode/modelId及Token身份摘要，绑定当前config revision；保存仅名称/排序变更时携带证据到新revision，地址/模式/实际模型/Token变化失效，删除映射失效。Token/绑定细节不进公共目录。

公开mapping.annotation={available:boolean,expression:"overlay-v1"|null,maxInputImages:2,reason:string|null}。内部解析器额外返回annotationCapability: ResolvedAnnotationCapability|null，其字段固定{expression:"overlay-v1",maxInputImages:2,configurationRevision:number,bindingSha256:string,evidenceSha256:string}。提供纯校验供备份使用。首次任务固定此能力；旧任务幂等/修复不查当前能力。

## 后端与持久化（data工作包）

0005由主代理创建：generation_runs.annotationSnapshot jsonb nullable、annotationExecution jsonb nullable、providerAnnotationCapability jsonb nullable；provider_settings.annotationCapabilities jsonb NOT NULL DEFAULT[]。不改既有迁移。snapshot包含geometry；execution存经过验证并准备好的真实输入绑定。PrivateRun公开annotationSnapshot|null；私有record额外annotationExecution，内部provider对象的annotationCapability由独立providerAnnotationCapability列固定受理证据。

RunCommand增加annotationSnapshot?:AnnotationSnapshot|null；只有本次父版本的快照，纳入规范化幂等指纹。允许仅批注无整体prompt；composeAnnotatedPrompt后再composePrompt文档，5000字总限。批注存在时必须parentVersionId一致且拒绝所有额外references；文档imageInspection必须为"none"。保留原有无批注请求指纹兼容，旧保存任务可修复。

受理只进行数据库/形状校验；COS原图读取/解码在事务外、模型前完成，验证assetId/尺寸/方向。使用现有reference-1保存原始基准副本、reference-2保存标注图，不增加公开命名空间。服务端生成两个输入角色。

AnnotationExecution类型由data工作包在lib/annotation-execution.ts定义并导出纯校验：包含schema=1、expression、renderVersion、snapshotSha256、原图assetId/hash/length/尺寸/方向、两个input id/key/hash/length、冻结能力。只包含有界安全数据。输入均保存成功后，将execution一次性冻结到数据库，然后才允许模型调用。annotationExecution null→值只允许preparing；重复或不同绑定拒绝。任务清单包含同一execution。

修复必须将manifest.input完整规范化请求、annotationSnapshot、execution与数据库冻结值对比，再核对原始资产及输入角色、字节/hash/长度/尺寸。不能根据当前配置重判旧任务，也不能重画辅助图或调用模型。必要完成检查沿用当前事务。

GET /api/images/[id]/metadata：仅当前已启用账号自己的资产，真实解码返回AnnotationImageMetadata；不落盘、no-store、异步后身份复核。UI只在已加载当前基准且metadata匹配/单帧时可画。元数据失败不阻断原本无批注流程。

## UI与草稿（UI工作包）

schema2迁移现有schema1草稿且不删除原件；所有snapshot/emergency/persistence白名单保留annotationDrafts。旧版无法理解schema2时必须停止覆盖。选版本只切换对应bucket；提交冻结baseVersionId+draft revision，成功仅清理该次且未再编辑的bucket，其余版本/较新输入保留。

图片object-contain实际显示框与SVG叠加对齐，所有绘制逆变换到encoded坐标。矩形、自由lasso、brush，编号稳定，浮框默认上方且窄屏可见；主输入引用共享同一对象，可定位/编辑/删除/撤销，浮框没有发送按钮。图片失效或当前任务在途时禁画/切基准并说明原因。键盘可添加中心矩形并移动/调整区域、选择说明、删除和提交；不能截获输入框中的历史快捷键。

Generation/PrivateRun保留服务器快照，历史以父版本+编号说明+结果回看，新设备不依赖本地草稿。普通目录安全projection保留annotation字段。提交显示当前不支持/材料占位原因，不能静默少传。

## 文档、发布与验证（主代理）

ParsedDocument增加imageInspection:"none"|"present"|"unknown"。只在可靠检测无图时none；提取失败或不能完整判断用unknown，不能靠images.length=0猜无图。常规文档解析体验保留；批注模式安全拒绝present/unknown并提示改为纯TXT。客户端预览携带该状态，后端重新解析。

主代理升级catalog、release policy min/max0005与browserWorkspaceSchema2、备份表白名单/结构/关系校验及physical schema；旧无批注记录保留null。无生产迁移；共享PG真实测试串行仅主代理执行，代理只跑自己的离线测试，勿启动服务/读取.env.local/提交/push。每个工作包读自己相关源码和父规格，发现契约冲突先通知主代理，不自行覆盖他人文件。

接口依据：[OpenAI图像生成](https://developers.openai.com/api/docs/guides/image-generation)、[图像提示](https://developers.openai.com/api/docs/guides/image-prompting)、[Gemini图像生成](https://ai.google.dev/gemini-api/docs/image-generation)。这些资料仅说明可表达方式与局限，不能证明任意用户网关/模型支持；实际绑定必须独立留证。
