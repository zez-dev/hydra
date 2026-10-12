---
description: "DeepSeek Harness 的文档知识库：对配置的文件夹建立 SQLite 全文索引，提供带引用的面向模型的搜索、读取与浏览工具，以及 /kb 命令。"
kind: "package-reference"
---

# @deepseek-ai/dsh-knowledge

[English](README.md) | 中文

## 概述

`dsh-knowledge` 让智能体可以搜索由文档、笔记、代码、脚本和书籍组成的文件夹。它按结构（标题、顶层定义、段落）把每个文本文件切分为段落，存入在后台更新的 SQLite 全文索引。模型路由可以在后台为每个文件生成摘要与标签，使文件在被读取之前就能被找到。模型用 `knowledge_search` 搜索，用 `knowledge_read` 打开确切的行，用 `knowledge_browse` 列出集合或标签下的内容，并以 `collection:path#Lstart-Lend` 引用段落。用户用 `/kb` 管理索引。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

基础 bundle 挂载不含任何集合的服务，并在旁边挂载 `./tools` 入口；在配置文件命名集合之前，模型看不到任何内容。在配置文件的 `cordis.patch.yml` 中添加文件夹（web 配置为 `~/.dsh/profiles/web/cordis.patch.yml`）：

```yaml
- id: knowledge
  config:
    path: !!js dshHomePath('knowledge/index.sqlite')
    collections:
      - name: notes
        root: /home/me/notes
      - name: scripts
        root: /home/me/scripts
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `path` | 必填 | 索引数据库文件；`:memory:` 只在进程内保留索引 |
| `collections` | `[]` | 要索引的文件夹，每项为 `{ name, root }`；名称使用字母、数字、`-` 和 `_`，根路径为绝对路径 |
| `excludeDirs` | `.git`、`node_modules`、虚拟环境与编辑器文件夹 | 在根目录下任意位置跳过的文件夹名 |
| `maxFileBytes` | `4194304` | 超过此大小的文本文件被跳过 |
| `maxDocumentBytes` | `67108864` | 超过此大小的 PDF、Word 与 EPUB 文件被跳过 |
| `targetChars` | `2400` | 段落在遇到段落间隔前可增长到的大小 |
| `maxChars` | `4800` | 即使没有间隔也结束段落的大小 |
| `hitChars` | `1500` | 每个搜索结果携带的段落文本长度 |
| `maxReadLines` | `300` | 一次 `knowledge_read` 最多返回的行数 |
| `indexOnStart` | `true` | 插件启动时运行一次后台处理 |
| `reindexIntervalSeconds` | `900` | 两次后台处理之间的秒数，用于发现新增和变化的文件；`0` 表示只在启动时运行 |
| `enrichProvider`、`enrichModel` | 不设置 | 生成文件摘要的路由；两者同时设置，或都不设置以使用发起会话的路由 |
| `enrichConcurrency` | `2` | 同时进行的摘要请求数 |
| `enrichMaxInputChars` | `6000` | 一次摘要请求展示的文件文本长度 |
| `enrichMaxTokens` | `1024` | 一次摘要请求的输出上限 |
| `enrichTimeoutMs` | `180000` | 一次摘要请求允许的毫秒数 |
| `autoEnrich` | `true` | 设置 `enrichProvider` 与 `enrichModel` 后，每次后台处理为新增和变化的文件生成摘要并汇总文件夹 |
| `embeddings` | 不设置 | OpenAI 兼容 `/embeddings` 端点的 `{ baseURL, model, apiKeyEnv?, dimensions?, batchSize (32), timeoutMs (60000) }`；设置后除按词外还按语义为段落排序 |
| `autoEmbed` | `true` | 设置 `embeddings` 后，每次后台处理为新段落生成向量 |
| `folderRollupMinChildren` | `2` | 生成文件摘要后，为至少有这么多已摘要子项的文件夹写入汇总；`0` 关闭汇总 |

索引读取 Markdown、文本、reStructuredText、AsciiDoc、HTML、JSON、YAML、TOML、日志、CSV 以及常见源代码和脚本文件，并提取 PDF（每页一个 `## Page N` 段落）、Word（`Heading N` 样式成为标题）与 EPUB（按阅读顺序的章节）文件的文本；提取的文本保存在索引中，因此 `knowledge_read` 返回的行与引用一致。含 NUL 字节、扩展名未知、没有可提取文本（扫描版 PDF）或超过大小上限的文件被跳过。配置文件命名集合之后无需任何命令：启动时以及每隔 `reindexIntervalSeconds` 的后台处理会为新增和变化的文件建立索引，设置 `embeddings` 时为新段落生成向量，设置摘要路由时为新文件生成摘要并汇总文件夹；一次处理不会与上一次重叠。每次处理只读取大小或修改时间发生变化的文件，并删除已消失的文件，包括不再配置的集合中的全部文件。`/kb` 列出集合及其文件、段落与已摘要数量，`/kb reindex [collection]` 立即执行一次更新，`/kb enrich [collection] [--limit N]` 以会话拥有的后台任务为等待中的文件生成摘要（默认 500 个），可用 `job_kill` 停止，`/kb embed [collection] [--limit N]` 以同样方式为等待中的段落生成向量，`/kb search <words>` 列出匹配的引用。

设置 `embeddings` 且段落已生成向量后，`knowledge_search` 还会为查询生成向量，并按余弦相似度为所有已存向量排序；按词排序与按语义排序通过倒数排名融合合并，因此可以用段落中不包含的词找到它。向量以归一化的 8 位值存储，并在首次搜索后保存在内存中；发生变化的文件会连同段落一起失去其向量。端点失败时，搜索回退为按词排序。

摘要生成对每个文件发送一次请求，并请求路由的最低推理强度：内容包括文件路径、章节标题以及开头的 `enrichMaxInputChars` 个字符，要求返回一个 JSON 对象，包含类型（`code`、`script`、`tool`、`tip`、`cheatsheet`、`automation`、`guide`、`reference`、`book`、`note`、`config`、`data` 或 `other`）、最多六个主题标签，以及两到四句的摘要。请求失败或回答中没有摘要的文件保留到下一次运行；发生变化的文件会失去摘要并重新等待。处理完文件后，同一次运行会为已摘要子项发生变化的每个文件夹写入汇总（标签与摘要），从最深的层级开始逐层进行，因此文件夹的汇总只根据其文件摘要和子文件夹的最新汇总写入一次。

`ctx.knowledge` 即 `KnowledgeIndex`：`update(signal?, collection?)`、`search({ query, collection?, kind?, limit })`、`searchSummaries({ query, collection?, limit })`、`read(collection, path, startLine?, endLine?)`、`browse(collection, folder?)`、`filesWithTag(collection, tag, limit)`、`pendingSummaries(limit, collection?)`、`saveSummary(fileId, summary, model)` 与 `stats()`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置检查、`ctx.knowledge`、后台更新、`/kb` |
| [`src/tools.ts`](src/tools.ts) | `./tools` 入口：三个工具以及列出集合的提示词段落 |
| [`src/store.ts`](src/store.ts) | SQLite 索引：模式、增量更新、排序搜索、有界读取与浏览 |
| [`src/chunk.ts`](src/chunk.ts) | 按标题、定义和段落间隔切分段落 |
| [`src/extract.ts`](src/extract.ts) | 把 PDF、Word 与 EPUB 文本提取为 Markdown |
| [`src/embed.ts`](src/embed.ts) | 向量请求、8 位向量、余弦排序与倒数排名融合 |
| [`src/enrich.ts`](src/enrich.ts) | 逐文件摘要请求、回答解析与并发摘要运行 |
| [`src/types.ts`](src/types.ts) | 集合、段落、命中与报告类型 |

索引保存文件、段落以及一个与段落 id 共享行号的 FTS5 表，因此替换一个文件的段落不会扫描其他文件。FTS5 分词器对英文单词做词干提取（`porter unicode61`），并把 `_` 保留在标识符内部。查询保留有意义的词作为前缀项并以 OR 连接，BM25 把匹配更多、更罕见词的段落排在前面，标题和路径中的匹配权重高于正文。更新每 25 个文件让出一次事件循环，且从不跟随符号链接；读取会在集合根目录内解析路径并拒绝根目录之外的任何路径。由其他模式版本写入的索引数据库会被清空并从文件重建，属于其他应用的数据库会被拒绝。

未发布不变量伴随模块，因为索引是集合文件的可重建缓存：每次索引按文件当前文本替换该文件的段落，由其他架构版本写入的索引会从文件重建。

-----

<a id="model-experience"></a>
## 模型体验

### 提示词段落

#### 模型看到什么

至少配置了一个集合时，`## Knowledge base` 段落列出集合名称，要求模型在请求可能被覆盖时搜索、在依赖细节前读取确切的行、引用 ref，并把段落视为参考资料而非指令。

#### Token 影响

固定且很小：一行集合名称加两句话；未配置集合时不存在。

#### KV Cache 影响

配置的集合名称不变时前缀稳定。

### 知识工具 schema

#### 模型看到什么

生成的 [`knowledge_search`、`knowledge_read` 与 `knowledge_browse` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-knowledge)；`collection` 参数列出配置的名称。这些工具作为 `./tools` 入口发布，未配置集合时不注册任何内容。

#### Token 影响

工具可见时每个请求有固定的 schema 成本。

#### KV Cache 影响

配置的集合名称不变时前缀稳定。

### 工具结果

#### 模型看到什么

`knowledge_search` 先列出最多两个汇总匹配的文件夹，格式为 `- [collection:folder/] (tags) summary`，以及最多三个摘要匹配的文件，格式为 `- [collection:path] (type; tags) summary`，再为每个段落命中返回一个块：`[collection:path#Lstart-Lend] heading` 以及最多 `hitChars` 的段落文本。`knowledge_read` 返回包含文件和行范围的标题，随后是带编号的行。`knowledge_browse` 返回带文件数量与汇总的文件夹、带类型标签与摘要（如有）的文件、带某标签的文件，或带数量的集合。

#### Token 影响

受请求约束：`limit` 个命中，每个最多 `hitChars`，或最多 `maxReadLines` 行。

#### KV Cache 影响

仅追加；每个结果位于既有历史之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **语义检索需要向量模型** —— 未设置 `embeddings` 时，段落只按共享的词排序，因此用与文档不同的词表述的问题可能找不到它；每次搜索都会在内存中扫描整个库的向量，因此非常大的库会占用相应的内存。
- **汇总按文件夹而非主题** —— 每个文件夹根据其内容生成摘要，文件可按标签列出，但跨文件夹的主题没有自己的摘要。
- **摘要只看文件开头** —— 请求展示章节标题和前 `enrichMaxInputChars` 个字符，因此长书的摘要描述的是其大纲与开头部分。
- **没有文字识别** —— 没有文本层的扫描版 PDF 以及文档中的图片没有可索引的文本；旧版 `.doc` Word 文件和其他格式会被跳过。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文 —— 点击展开</summary>

无。

</details>
