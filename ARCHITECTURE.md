# 代码结构与数据流

扩展为 Manifest V3，直接运行本地 JavaScript，不需要服务端或前端构建步骤。界面、采集、校验和整理分开，原始响应是校验和重新整理的依据。

```text
工具栏点击 → 原生侧栏 → 后台采集路由 → 固定标签/文档的读取器
                                      ↓
                            原始响应 + 来源 + SHA-256
                                      ↓
                         原子保存页与进度到 IndexedDB
                                      ↓
                           顺序/重复/边界/结束复核
                                      ↓
                       原始 JSON / 整理 JSON / TXT
```

## 模块索引

| 文件 | 职责 |
| --- | --- |
| `manifest.json`、`background.js` | 权限、入口、Service Worker 及侧栏连接 |
| `panel.html`、`panel.css`、`panel.js` | 记录管理、采集控制、预览与下载 |
| `background-power.js`、`sleep.html` | 持久休眠、唤醒及释放控制器 |
| `capture-store.js` | IndexedDB 会话、响应、任务与原子进度更新 |
| `capture-router.js` | 根据平台和记录原有模式选择采集器 |
| `page-reader.js`、`core.js`、`background-capture.js` | ChatGPT 限定请求、分页校验及后台循环 |
| `claude-reader.js`、`claude-core.js`、`claude-capture.js` | Claude 请求、消息树校验及采集 |
| `provider-reader.js`、`provider-core.js`、`provider-capture.js` | DeepSeek / Gemini 限定请求、解析、游标与后台采集 |
| `surface-reader.js`、`surface-core.js`、`surface-capture.js` | 网页快照、滚动、重叠合并与备用采集 |
| `organize.js` | 按来源格式整理、筛选、导出文本和预览 |
| `platforms.js`、`browser-context.js`、`background-client.js` | 平台识别、浏览器上下文与消息传递 |
| `devtools.html`、`devtools.js` | 旧 F12 兼容入口 |

表中路径均位于 `edge-extension/`。根目录 `organize_capture.cjs` 调用同一套整理器；Python 校验工具用于离线对照，`build_icons.py` 是图标重建源码。

## 完整性约束

采集固定到用户启动时的标签、文档和聊天。改变来源、同一消息内容冲突、缺失父节点、分页游标循环或不支持的结构会停止并保留已有数据，不凭时间排序或猜测版本来掩盖缺口。

分页和消息树使用各自来源关系确定顺序；结束复核检查首页或消息树是否变化。SHA-256 用于验证保存后的原始正文没有改变，不是平台签名，也不能证明服务端已返回全部历史。

保存采用运行编号、任务检查点和删除墓碑隔离旧响应，采集锁防止多个入口同时写入。原始数据和整理结果分开；辅助片段可以不进入阅读结果，但仍保留其已取得的来源。

Gemini 返回多个候选且当前版本未核验时，正文整理会拒绝猜测；全部类型输出注明候选范围。网页模式的输出始终声明未验证服务端完整历史。

## 审阅入口

审查网络范围先看 `*-reader.js`；审查归档判断看 `*-core.js`；审查后台生命周期看 `*-capture.js` 与 `background-power.js`；审查用户可见文本输出看 `organize.js`。测试由 `test_core.cjs` 汇总，包含隔离的页面、后台、存储和导出场景。
