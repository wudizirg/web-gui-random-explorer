# Web GUI Random Explorer

这是一个面向网页 GUI 测试输入生成的大作业项目，当前版本先实现**自动随机探索**能力：

- 自动访问目标网页
- 随机点击可交互元素
- 随机向输入框填充文本
- 记录每一步动作日志，便于后续接入大模型进行策略优化

## 安装

```bash
npm install
```

## 配置 `.env`

先复制一份示例文件：

```bash
cp .env.example .env
```

然后按需填写这些变量：

- `OPENAI_API_KEY`：LLM 接口密钥
- `OPENAI_MODEL`：模型名称，默认 `gpt-4o-mini`
- `OPENAI_ENDPOINT`：接口地址，不填则使用 OpenAI 默认地址

项目启动时会自动读取 `.env`。

## 运行

```bash
npm run dev -- --url https://example.com --steps 20
```

可选参数：

- `--url` 目标网页
- `--steps` 探索步数
- `--seed` 固定随机种子，便于复现
- `--headless false` 以可视化模式运行

## 后续扩展方向

- 增加页面状态抽象与表单结构感知
- 接入大模型，生成更聪明的点击/输入序列
- 增加截图、DOM 快照、异常检测与回溯
