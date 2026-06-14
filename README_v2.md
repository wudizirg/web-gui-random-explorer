# Web GUI 智能探索测试工具

> 软件测试导论 期末大作业 — 完善版

面向网页 GUI 测试输入生成的智能探索工具。基于 Playwright 浏览器自动化 + LLM 大模型辅助决策，具备**页面状态感知**、**表单结构理解**、**异常检测与自动回溯恢复**能力。

---

## ✨ 核心能力

### 🎯 三个完善方向（已全部实现）

| 方向 | 核心模块 | 能力描述 |
|------|----------|----------|
| **① 页面状态抽象与表单结构感知** | `state-machine.ts` + `form-analyzer.ts` | FSM 页面状态机（8 种状态分类）、页面指纹计算、`<form>` 结构解析、label 关联、required 约束检测 |
| **② 大模型智能策略增强** | `llm-strategist.ts` | 表单结构注入 Prompt、多步规划、状态感知对话、异常感知上下文 |
| **③ 截图/DOM快照/异常检测/回溯** | `dom-snapshot.ts` + `anomaly-detector.ts` + `backtracker.ts` | 每步 DOM 简化树 JSON 快照、6 类异常实时检测、自动回溯恢复 |

---

## 📁 项目结构

```
Abtext-main/
├── src/
│   ├── cli.ts                 # CLI 入口 & 参数解析
│   ├── explorer.ts            # 核心探索引擎（集成全部模块）
│   ├── types.ts               # 类型定义（12+ 新增类型）
│   ├── state-machine.ts       # [新增] 页面状态机 (FSM)
│   ├── form-analyzer.ts       # [新增] 表单结构感知
│   ├── llm-strategist.ts      # [新增] 增强 LLM 策略层
│   ├── dom-snapshot.ts        # [新增] DOM 简化树快照
│   ├── anomaly-detector.ts    # [新增] 异常检测器
│   ├── backtracker.ts         # [新增] 状态回溯管理器
│   └── types/
│       └── seedrandom.d.ts
├── screenshots/               # 截图输出目录
├── snapshots/                 # DOM 快照 JSON 输出目录
├── dist/                      # 编译输出
├── scripts/
│   ├── generate_ppt.py        # PPT 生成脚本
│   ├── generate_pdf.py        # PDF 生成脚本
│   └── export_pdf.py          # PPTX→PDF 导出脚本
├── README.md                  # 原始 README（保留）
├── README_v2.md               # 本文件 — 完善版说明
├── 完善方案讲解.pptx           # 方案讲解 PPT (17 页)
└── 完善方案讲解.pdf            # 方案讲解 PDF
```

---

## 🚀 快速开始

### 安装

```bash
npm install
```

### 配置 `.env`

```bash
cp .env.example .env
```

填写 LLM 相关环境变量：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `OPENAI_API_KEY` | LLM 接口密钥 | — |
| `OPENAI_MODEL` | 模型名称 | `gpt-4o-mini` |
| `OPENAI_ENDPOINT` | 接口地址（支持中转 API） | `https://api.openai.com/v1/chat/completions` |

### 基础运行

```bash
# 随机探索模式（不使用 LLM）
npm run dev -- --url https://example.com --steps 20

# LLM 辅助探索模式
npm run dev -- --url https://example.com --steps 20 --llm true

# 固定随机种子（便于复现）
npm run dev -- --url https://example.com --steps 30 --seed my-seed

# 可视化模式（非 headless）
npm run dev -- --url https://example.com --headless false
```

### 编译

```bash
npm run build    # tsc 编译 → dist/
```

---

## 🔧 完整 CLI 参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `--url` | string | `https://example.com` | 目标网页 URL |
| `--steps` | number | `20` | 探索步数 |
| `--seed` | string | 随机 | 固定随机种子 |
| `--headless` | bool | `true` | 无头模式 |
| `--llm` | bool | `false` | 启用 LLM 辅助决策 |
| `--llm-vision` | string | `always` | 截图发送策略：`always` / `on-navigation` |
| `--llm-conversation` | bool | `true` | 多轮对话模式 |
| `--model` | string | `gpt-4o-mini` | LLM 模型名 |
| `--endpoint` | string | — | LLM API 地址 |
| `--apiKey` | string | — | LLM API Key（优先级高于 .env） |
| `--anomaly-detection` | bool | `true` | 🆕 启用异常检测 |
| `--max-backtrack` | number | `3` | 🆕 最大回溯次数 |
| `--dom-snapshot` | bool | `true` | 🆕 启用 DOM 快照 |
| `--snapshot-dir` | string | `./snapshots` | 🆕 DOM 快照输出目录 |

---

## 🧠 架构详解

### 单步执行流程

```
Step N 开始
  │
  ├─ 1. capturePageContext()       → 截图 (已有)
  ├─ 2. DomSnapshot.capture()      → DOM 快照 JSON  [新增]
  ├─ 3. StateMachine.fingerprint() → 页面指纹  [新增]
  │    └─ StateMachine.classify()  → 页面状态分类  [新增]
  ├─ 4. FormAnalyzer.analyze()     → 表单结构  [新增]
  ├─ 5. LlmStrategist.buildPrompt()→ 增强 Prompt  [新增]
  │    └─ callLlm()                → LLM 决策 (增强)
  ├─ 6. executeAction()            → 执行动作 (已有)
  └─ 7. AnomalyDetector.check()    → 异常检测  [新增]
       │
       ├─ 严重异常 → Backtracker.recover() → goBack + 重试
       └─ 无异常   → Step N+1
```

### 页面状态机 (FSM)

| 状态类型 | 触发条件 |
|----------|----------|
| `initial` | 首次访问，未检测到明确特征 |
| `login` | 检测到密码字段 + 登录相关关键词 |
| `register` | 检测到注册表单 |
| `form` | 检测到普通表单（含 submit 按钮） |
| `content` | 无表单的普通内容页 |
| `error` | URL/内容匹配 404/500 等错误关键词 |
| `logged-in` | 检测到 logout/account/dashboard 等 |
| `form-submitted` | 表单提交后的确认页面 |

### 异常检测类型

| 异常类型 | 检测方式 |
|----------|----------|
| `js-error` | `page.on('pageerror')` 未捕获 JS 异常 |
| `console-error` | `page.on('console')` error 级别日志 |
| `page-crash` | `page.on('crash')` 页面崩溃 |
| `http-error` | 页面文本匹配 4xx/5xx 关键词 |
| `blank-page` | `body.innerText` 过短 & 子元素过少 |
| `navigation-loss` | 导航到外部域名 |

---

## 📊 完善前后对比

| 维度 | 完善前 | 完善后 |
|------|--------|--------|
| 源文件数 | 3 | 9 |
| 代码行数 | ~520 | ~2000 |
| 页面状态感知 | ❌ 无 | ✅ FSM 8 种状态 |
| 表单结构理解 | ❌ 仅枚举 input | ✅ label/required/类型 |
| LLM Prompt | 基础元素列表 | ✅ 状态+表单+进度+异常 |
| DOM 持久化 | ❌ 无 | ✅ 每步 JSON + diff |
| 异常检测 | ❌ 无 | ✅ 6 类实时检测 |
| 故障恢复 | ❌ 出错即停止 | ✅ 自动回溯 goBack |

---

## 🛠️ 技术栈

- **TypeScript** 5.x — 类型安全
- **Playwright** 1.49 — 浏览器自动化
- **OpenAI API** (兼容格式) — LLM 辅助决策
- **seedrandom** — 可复现随机
- **Node.js** — 运行时

---

## 📝 输出产物

| 产物 | 路径 | 说明 |
|------|------|------|
| 截图 | `screenshots/step-001.png` ~ `step-NNN.png` | 每步 fullPage 截图 |
| DOM 快照 | `snapshots/dom-step-001.json` ~ | 简化 DOM 树 JSON |
| 动作日志 | stdout JSON | 最终输出完整日志 |
| 状态转移 | stdout | 探索总结中的 FSM 摘要 |

---

## 🔮 后续展望

- [ ] **短期**：状态转移图可视化（Mermaid）、HTML 测试报告生成、表单填充策略库
- [ ] **中期**：覆盖率指标（状态/字段/路径）、并发多浏览器探索、断言系统
- [ ] **长期**：强化学习替代随机策略、视觉回归测试、CI/CD 集成

---

## 📄 相关文件

- 原始 README：[README.md](./README.md)
- 
