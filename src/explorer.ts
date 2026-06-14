import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, Page } from "playwright";
import seedrandom from "seedrandom";
import { ActionLog, ActionType, ExplorerOptions, LlmAction, LlmVisionMode, PageContext } from "./types.js";
import { PageStateMachine } from "./state-machine.js";
import { FormAnalyzer } from "./form-analyzer.js";
import { DomSnapshot } from "./dom-snapshot.js";
import { AnomalyDetector } from "./anomaly-detector.js";
import { Backtracker } from "./backtracker.js";
import { LlmStrategist } from "./llm-strategist.js";

const EXPLORER_ATTR = "data-gui-explorer-id";

/** 兼容 OpenAI 及部分中转：assistant.content 可能是 string 或 content part 数组 */
function extractAssistantMessageText(data: unknown): string | null {
  const content = (data as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part: unknown) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part && typeof (part as { text: string }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("");
    return text || null;
  }
  return null;
}

function normalizeLlmAction(parsed: LlmAction): LlmAction | null {
  const raw = typeof parsed.action === "string" ? parsed.action.trim().toLowerCase() : "";
  const synonyms: Record<string, ActionType> = {
    click: "click",
    tap: "click",
    press: "click",
    input: "input",
    type: "input",
    fill: "input",
    enter: "input",
    scroll: "scroll",
    back: "back",
    wait: "wait",
    idle: "wait",
    select: "click",
  };
  const mapped = synonyms[raw];
  if (!mapped || !["click", "input", "scroll", "back", "wait"].includes(mapped)) {
    console.warn(`[llm] 无法识别的 action: "${parsed.action}"，本轮跳过`);
    return null;
  }
  parsed.action = mapped;
  return parsed;
}

function pickRandom<T>(rng: () => number, values: T[]): T {
  return values[Math.floor(rng() * values.length)];
}

function randomText(rng: () => number, length = 8): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i += 1) {
    result += alphabet[Math.floor(rng() * alphabet.length)];
  }
  return result;
}

type AnnotatedCandidates = Awaited<ReturnType<typeof annotateAndCollectElements>>;

const FILLED_INPUT_ATTR = "data-gui-explorer-filled";

async function annotateAndCollectElements(page: Page) {
  try {
    const clickables = await page.locator("button, a[href], input:not([type='hidden']):not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [role='button'], [role='link'], [role='menuitem'], [role='tab'], [contenteditable='true'], [onclick], [tabindex]:not([tabindex='-1'])").evaluateAll((els) =>
      els.map((el, idx) => {
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute("role");
        const text = String((el as HTMLElement).textContent || (el as HTMLInputElement).value || "").trim().slice(0, 80);
        const name = el.getAttribute("name");
        const id = el.id;
        const selectorHint = id ? `#${id}` : name ? `[name="${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]` : role ? `${tag}[role="${role}"]` : tag;
        return { index: idx, tag, text, selectorHint, stableSelector: "" };
      })
    ).catch(() => [] as Array<{ index: number; tag: string; text: string; selectorHint: string; stableSelector: string }>);

    const inputs = await page.locator("input:not([type='hidden']):not([disabled]), textarea:not([disabled]), select:not([disabled]), [contenteditable='true']").evaluateAll((els) =>
      els.map((el, idx) => {
        const tag = el.tagName.toLowerCase();
        const type = el.getAttribute("type") || "text";
        const name = el.getAttribute("name");
        const id = el.id;
        const role = el.getAttribute("role");
        const selectorHint = id ? `#${id}` : name ? `[name="${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]` : role ? `${tag}[role="${role}"]` : tag;
        const filled = Boolean((el as HTMLInputElement).value || (el as HTMLElement).getAttribute(FILLED_INPUT_ATTR));
        return { index: idx, tag, type, selectorHint, stableSelector: "", filled };
      })
    ).catch(() => [] as Array<{ index: number; tag: string; type: string; selectorHint: string; stableSelector: string; filled?: boolean }>);

    const scrollables: Array<{ index: number; tag: string; text: string; selectorHint: string; stableSelector: string }> = [];

    return {
      clickables: clickables.map((item, idx) => ({ ...item, index: idx, stableSelector: `[${EXPLORER_ATTR}="${idx}"]` })),
      scrollables,
      inputs: inputs.map((item, idx) => ({ ...item, index: clickables.length + idx, stableSelector: `[${EXPLORER_ATTR}="${clickables.length + idx}"]`, filled: (item as { filled?: boolean }).filled })),
    };
  } catch (error) {
    console.warn("[explorer] annotateAndCollectElements 失败:", error);
    return {
      clickables: [] as Array<{
        index: number;
        tag: string;
        text: string;
        selectorHint: string;
        stableSelector: string;
      }>,
      scrollables: [] as Array<{
        index: number;
        tag: string;
        text: string;
        selectorHint: string;
        stableSelector: string;
      }>,
      inputs: [] as Array<{
        index: number;
        tag: string;
        type: string;
        selectorHint: string;
        stableSelector: string;
      }>,
    };
  }
}

function summarizeElements(candidates: AnnotatedCandidates) {
  const clickableText = candidates.clickables
    .slice(0, 12)
    .map((item) => `- [${item.index}] click — ${item.tag} "${item.text || item.selectorHint}"`)
    .join("\n");
  const scrollableText = candidates.scrollables
    .slice(0, 8)
    .map((item) => `- [${item.index}] scroll — ${item.tag} "${item.text || item.selectorHint}"`)
    .join("\n");
  const inputText = candidates.inputs
    .slice(0, 12)
    .map((item) => `- [${item.index}] input — ${item.tag} type=${item.type} (${item.selectorHint})${(item as { filled?: boolean }).filled ? " [filled]" : ""}`)
    .join("\n");
  return [clickableText, scrollableText, inputText].filter(Boolean).join("\n");
}

function summarizeFilledInputs(candidates: AnnotatedCandidates) {
  const filled = candidates.inputs.filter((item) => (item as { filled?: boolean }).filled);
  if (filled.length === 0) return "- none";
  return filled
    .slice(0, 12)
    .map((item) => `- [${item.index}] ${item.tag} (${item.selectorHint})`)
    .join("\n");
}

function getCapabilities(candidates: AnnotatedCandidates) {
  const caps = ["click"];
  if (candidates.scrollables.length > 0) caps.push("scroll");
  if (candidates.inputs.length > 0) caps.push("input");
  return caps;
}

async function capturePageContext(page: Page, screenshotDir: string, step: number) {
  await mkdir(screenshotDir, { recursive: true });
  const screenshotPath = path.join(screenshotDir, `step-${String(step).padStart(3, "0")}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const candidates = await annotateAndCollectElements(page);
  return {
    url: page.url(),
    title: await page.title().catch(() => ""),
    screenshotPath,
    capabilities: getCapabilities(candidates),
    elementsSummary: summarizeElements(candidates),
    filledInputsSummary: summarizeFilledInputs(candidates),
    clickableCount: candidates.clickables.length,
    inputCount: candidates.inputs.length,
  } satisfies PageContext;
}

function buildPrompt(context: PageContext, imageAttached: boolean, conversationTurn?: number) {
  const clickHi = context.clickableCount > 0 ? context.clickableCount - 1 : -1;
  const inputLo = context.clickableCount;
  const inputHi = context.inputCount > 0 ? context.clickableCount + context.inputCount - 1 : -1;
  const indexHelp =
    context.clickableCount > 0 || context.inputCount > 0
      ? `Index ranges on this page:\n- For action "click": prefer a precise CSS selector; if you use targetIndex, it must be in ${context.clickableCount > 0 ? `0..${clickHi}` : "none"}.\n- For action "input": prefer a precise CSS selector for the input element; if you use targetIndex, it must be in ${context.inputCount > 0 ? `${inputLo}..${inputHi}` : "none"} and set "value".\n`
      : "No indexed interactive elements were detected; you may use scroll, back, wait, or a precise CSS selector.\n";

  const visionNote = imageAttached
    ? "A screenshot image of the current page is attached. Use it together with the numbered list—indices match labels we drew in the list (same order as DOM scraping)."
    : "No screenshot this step (same URL as the previous step). Rely on URL/title and the element list only.";

  const filledInputsNote = context.filledInputsSummary
    ? `Already filled inputs on this page:\n${context.filledInputsSummary}\n`
    : "Already filled inputs on this page:\n- none\n";

  const formStrategyNote = `Form-filling strategy:\n- Treat this as a stateful multi-step task, not an independent one-step task.\n- If a username field has already been filled, do not fill it again.\n- Prefer the next unfinished field in natural order.\n- On login pages, the usual order is username -> password -> submit.\n- If multiple inputs are present, choose exactly one input per step and move to the next unfinished field on the following step.\n- Use the filled-input list below to avoid repeating work.\n`;

  const turnNote = conversationTurn ? `Conversation turn: ${conversationTurn}\n` : "";

  return `You are controlling a real browser for GUI exploration / testing.\n\n${turnNote}${visionNote}\n\nCurrent page:\n- URL: ${context.url}\n- Title: ${context.title}\n- Screenshot file (for your logs only): ${context.screenshotPath}\n\n${indexHelp}Allowed action types:\n- click — choose a CSS selector for the clickable element, or a clickable index as fallback\n- input — choose a CSS selector for ONE visible input element, or an input index as fallback, and set "value"\n- scroll — "amount" in pixels (positive scrolls down), default 600\n- back — history back\n- wait — idle ~1s\n\nImportant form-filling rules:\n- This API returns only ONE action per step.\n- If multiple inputs exist on the page, fill them across multiple steps, one input at a time.\n- Prefer visible, empty, relevant inputs in reading order.\n- For login / form pages, usually fill the first text field first, then the password field, then click submit.\n- Do not skip remaining inputs just because one input was filled successfully.\n\n${formStrategyNote}Capabilities detected: ${context.capabilities.join(", ")}\n\n${filledInputsNote}Numbered candidates:\n${context.elementsSummary || "- none detected"}\n\nReturn ONLY one JSON object (no markdown):\n{"action":"click|input|scroll|back|wait","selector":"precise CSS selector","value":"...","amount":600,"reason":"..."}\nUse "selector" first. Use "targetIndex" only if you cannot identify a selector.`;
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

async function callLlm(
  messages: ChatMessage[],
  apiKey: string | undefined,
  endpoint: string | undefined,
  model: string,
  screenshotPath: string,
  includeImage: boolean
): Promise<string | null> {
  const url = endpoint ?? "https://api.openai.com/v1/chat/completions";
  const proxyEnv = {
    HTTP_PROXY: process.env.HTTP_PROXY ?? process.env.http_proxy ?? "<unset>",
    HTTPS_PROXY: process.env.HTTPS_PROXY ?? process.env.https_proxy ?? "<unset>",
    ALL_PROXY: process.env.ALL_PROXY ?? process.env.all_proxy ?? "<unset>",
  };

  const latestUserMessage = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
  console.log(
    `[llm] 准备调用: enabled=${Boolean(apiKey)}, model=${model}, endpoint=${url}, includeImage=${includeImage}, screenshot=${screenshotPath}, turns=${messages.length}`
  );
  console.log(
    `[llm] 代理环境: HTTP_PROXY=${proxyEnv.HTTP_PROXY}, HTTPS_PROXY=${proxyEnv.HTTPS_PROXY}, ALL_PROXY=${proxyEnv.ALL_PROXY}`
  );

  if (!apiKey) {
    console.warn("[llm] 未提供 API key，跳过 LLM 调用");
    return null;
  }

  if (url.includes("/v1/responses")) {
    console.error(
      "[llm] 当前代码只支持 Chat Completions：请把 OPENAI_ENDPOINT / --endpoint 设为以 …/v1/chat/completions 结尾的地址，不要使用 …/v1/responses（Responses API 使用 input 字段，与本程序的 messages 格式不兼容）。"
    );
    return null;
  }

  let userContent: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  if (includeImage) {
    const buf = await readFile(screenshotPath);
    const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
    userContent = [
      { type: "text", text: latestUserMessage },
      { type: "image_url", image_url: { url: dataUrl } },
    ];
  } else {
    userContent = latestUserMessage;
  }

  const body = JSON.stringify({
    model,
    messages,
    temperature: 0.2,
    max_tokens: 500,
  });
  console.log(`[llm] 请求体大小=${Buffer.byteLength(body, "utf8")} bytes`);

  const controller = new AbortController();
  const timeoutMs = 20000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  console.log(`[llm] 发起请求，timeout=${timeoutMs}ms`);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body,
    });
    console.log(`[llm] 收到 HTTP 响应: status=${res.status} ok=${res.ok} elapsed=${Date.now() - startedAt}ms`);
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(`[llm] HTTP ${res.status}: ${errText.slice(0, 500)}`);
      return null;
    }
    const data = (await res.json()) as unknown;
    console.log(`[llm] 响应 JSON keys=${Object.keys(data as Record<string, unknown>).join(",")}`);
    const text = extractAssistantMessageText(data);
    console.log(`[llm] 收到响应文本=${Boolean(text)} length=${text?.length ?? 0}`);
    if (text) {
      console.log(`[llm] 响应前 300 字符: ${text.slice(0, 300)}`);
    } else {
      console.warn("[llm] 响应中未找到 assistant 文本（choices[0].message.content 可能为空或非预期格式）");
    }
    return text;
  } catch (error) {
    const err = error as { name?: string; message?: string; cause?: unknown };
    console.error(`[llm] 请求失败: name=${err.name ?? "unknown"}, message=${err.message ?? "unknown"}`);
    if (err.cause) {
      console.error("[llm] cause=", err.cause);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function parseLlmAction(raw: string | null): LlmAction | null {
  if (!raw) return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as LlmAction;
    if (parsed.targetIndex !== undefined && typeof parsed.targetIndex === "string") {
      parsed.targetIndex = Number.parseInt(parsed.targetIndex, 10);
    }
    return normalizeLlmAction(parsed);
  } catch {
    return null;
  }
}

function resolveTargetSelector(action: LlmAction): string | undefined {
  if (action.selector && action.selector.trim()) return action.selector.trim();
  if (action.targetIndex !== undefined && action.targetIndex !== null) {
    const idx = Number(action.targetIndex);
    if (Number.isFinite(idx) && idx >= 0) {
      return `[${EXPLORER_ATTR}="${Math.floor(idx)}"]`;
    }
  }
  return undefined;
}

function isValidTargetIndex(action: LlmAction, context: PageContext): boolean {
  if (action.targetIndex === undefined || action.targetIndex === null) return true;
  const idx = Number(action.targetIndex);
  if (!Number.isFinite(idx) || idx < 0) return false;
  const normalized = Math.floor(idx);
  if (action.action === "click") {
    return normalized >= 0 && normalized < context.clickableCount;
  }
  if (action.action === "input") {
    return normalized >= context.clickableCount && normalized < context.clickableCount + context.inputCount;
  }
  return true;
}

async function executeAction(page: Page, action: LlmAction, context: PageContext, rng: () => number, step: number): Promise<ActionLog | null> {
  switch (action.action) {
    case "click": {
      const selector = resolveTargetSelector(action);
      if (!selector) {
        console.warn("[explorer] click 缺少 selector 或 targetIndex");
        return null;
      }
      const locator = page.locator(selector).first();
      try {
        await locator.waitFor({ state: "visible", timeout: 20000 });
        await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
        await locator.click({ timeout: 20000 });
      } catch (first) {
        console.warn(`[explorer] 首次点击失败 ${selector}，尝试 force 点击:`, first);
        try {
          await locator.click({ timeout: 20000, force: true });
        } catch (second) {
          console.warn(`[explorer] 点击仍失败（元素被遮挡、未附着 DOM 或索引已失效）: ${selector}`, second);
          return null;
        }
      }
      return { step, type: "click", label: action.reason || "llm click", selector, details: action.reason };
    }
    case "input": {
      const selector = resolveTargetSelector(action);
      if (!selector) {
        console.warn("[explorer] input 缺少 selector 或 targetIndex");
        return null;
      }
      const value = action.value ?? randomText(rng, 10);
      const locator = page.locator(selector).first();
      try {
        await locator.waitFor({ state: "visible", timeout: 20000 });
        await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
        await locator.fill(value, { timeout: 20000 });
        await locator.evaluate((el) => {
          el.setAttribute("data-gui-explorer-filled", "true");
        }).catch(() => null);
      } catch {
        try {
          await locator.click({ timeout: 20000, force: true });
          await locator.pressSequentially(value, { delay: 25 });
          await locator.evaluate((el) => {
            el.setAttribute("data-gui-explorer-filled", "true");
          }).catch(() => null);
        } catch (second) {
          console.warn(`[explorer] 输入失败: ${selector}`, second);
          return null;
        }
      }
      return { step, type: "input", label: action.reason || "llm input", selector, value, details: action.reason };
    }
    case "scroll": {
      const amount = action.amount ?? 600;
      await page.mouse.wheel(0, amount).catch(() => null);
      return { step, type: "scroll", label: action.reason || "llm scroll", details: action.reason };
    }
    case "back": {
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => null);
      return { step, type: "back", label: action.reason || "llm back", details: action.reason };
    }
    case "wait": {
      await page.waitForTimeout(1000);
      return { step, type: "wait", label: action.reason || "llm wait", details: action.reason };
    }
    default:
      return null;
  }
}

async function fallbackRandomStep(page: Page, rng: () => number, step: number, maxInputsPerPage: number): Promise<ActionLog | null> {
  const candidates = await annotateAndCollectElements(page);

  for (const item of candidates.inputs.slice(0, maxInputsPerPage)) {
    const locator = page.locator(item.stableSelector).first();
    const value = randomText(rng, 10);
    const filled = await locator
      .fill(value, { timeout: 2000 })
      .then(() => true)
      .catch(async () => {
        await locator.pressSequentially(value, { delay: 20 }).catch(() => null);
        return true;
      })
      .catch(() => false);
    if (filled) {
      return { step, type: "input", label: item.tag, selector: item.stableSelector, value };
    }
  }

  for (const item of candidates.clickables) {
    const clicked = await page.locator(item.stableSelector).first().click({ timeout: 2000 }).then(() => true).catch(() => false);
    if (clicked) {
      return { step, type: "click", label: item.text || item.tag, selector: item.stableSelector };
    }
  }

  for (const item of candidates.scrollables) {
    const locator = page.locator(item.stableSelector).first();
    const amount = rng() > 0.5 ? 700 : -700;
    const scrolled = await locator
      .evaluate((el, delta) => {
        const node = el as HTMLElement;
        node.scrollBy({ top: Number(delta), behavior: "smooth" });
        return true;
      }, amount)
      .then(() => true)
      .catch(() => false);
    if (scrolled) {
      return { step, type: "scroll", label: item.text || item.tag, selector: item.stableSelector, details: "scrollable container" };
    }
  }

  return null;
}

export async function explore(options: ExplorerOptions): Promise<ActionLog[]> {
  const rng = seedrandom(options.seed ?? String(Date.now()));
  console.log(`[explorer] 启动浏览器，headless=${options.headless ?? true}`);
  const browser = await chromium.launch({ headless: options.headless ?? true });
  const page = await browser.newPage();
  const logs: ActionLog[] = [];
  const screenshotDir = options.screenshotDir ?? path.join(process.cwd(), "screenshots");
  const snapshotDir = options.snapshotDir ?? path.join(process.cwd(), "snapshots");
  const llmConversationEnabled = options.llmConversation ?? true;

  // ── 初始化新模块 ──
  const stateMachine = new PageStateMachine();
  const formAnalyzer = new FormAnalyzer();
  const domSnapshot = new DomSnapshot();
  const anomalyDetector = new AnomalyDetector();
  const backtracker = new Backtracker(options.maxBacktrack ?? 3);
  const llmStrategist = new LlmStrategist();

  const enableAnomaly = options.anomalyDetection !== false; // 默认启用
  const enableDomSnapshot = options.domSnapshot !== false;   // 默认启用

  const conversationMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    {
      role: "system",
      content: options.llmEnabled
        ? llmStrategist.buildSystemPrompt()
        : "You are a browser automation assistant. Output only one JSON object per turn.",
    },
  ];

  try {
    console.log(`[explorer] 打开页面: ${options.url}`);
    await page.goto(options.url, { waitUntil: "domcontentloaded", timeout: options.timeoutMs ?? 30000 });
    console.log(`[explorer] 页面已打开: ${page.url()}`);

    // 附加异常检测器
    if (enableAnomaly) {
      anomalyDetector.attach(page, options.url);
      console.log("[explorer] 异常检测已启用");
    }

    let lastCaptureUrl = "";
    const visionMode: LlmVisionMode = options.llmVision ?? "always";

    for (let step = 1; step <= options.steps; step += 1) {
      console.log(`[explorer] step ${step}/${options.steps} 开始`);

      // ── 1. 截图 + 元素采集（已有）──
      const context = await capturePageContext(page, screenshotDir, step);
      console.log(`[explorer] step ${step} candidates: clickables=${context.clickableCount}, inputs=${context.inputCount}, capabilities=${context.capabilities.join(",")}`);

      // ── 2. 表单结构分析 [新增] ──
      const formSchemas = await formAnalyzer.analyze(page);
      const fillProgress = formAnalyzer.fillProgressSummary(formSchemas);
      if (formSchemas.length > 0) {
        console.log(`[explorer] step ${step} 检测到 ${formSchemas.length} 个表单, 共 ${formSchemas.reduce((s, f) => s + f.fields.length, 0)} 个字段`);
      }

      // ── 3. 页面状态指纹 [新增] ──
      const keyTexts = await page
        .evaluate(() => {
          const buttons = Array.from(document.querySelectorAll("button, a, [role='button'], h1, h2, h3"));
          return buttons
            .map((el) => (el.textContent || "").trim().slice(0, 50))
            .filter(Boolean)
            .slice(0, 10);
        })
        .catch(() => [] as string[]);
      const fingerprint = stateMachine.fingerprint(
        context.url,
        context.title,
        formSchemas,
        keyTexts
      );
      const isNew = stateMachine.isNewState(fingerprint);
      const stateNode = stateMachine.registerState(fingerprint, step);
      if (isNew) {
        console.log(`[explorer] step ${step} 新状态: ${stateNode.stateType} (${stateMachine.fingerprintKey(fingerprint).slice(0, 60)}...)`);
      }

      // ── 4. DOM 快照 [新增] ──
      let domSnapshotPath: string | undefined;
      if (enableDomSnapshot) {
        try {
          const snapshot = await domSnapshot.capture(page, step, formSchemas, context.elementsSummary);
          domSnapshotPath = await domSnapshot.save(snapshotDir, snapshot);
          const diffs = domSnapshot.diff(domSnapshot.getPrevious(), snapshot);
          if (diffs.length > 0 && !diffs[0].includes("首次")) {
            console.log(`[explorer] step ${step} DOM diff: ${diffs.join("; ")}`);
          }
          domSnapshot.setPrevious(snapshot);
        } catch (err) {
          console.warn(`[explorer] step ${step} DOM 快照失败:`, err);
        }
      }

      // ── 5. 保存回溯快照 [新增] ──
      backtracker.saveSnapshot(step, context.url, fingerprint, context.screenshotPath, domSnapshotPath);

      // ── 6. 构建增强 Prompt [增强] ──
      const navigatedSinceLastStep = step === 1 || context.url !== lastCaptureUrl;
      lastCaptureUrl = context.url;

      const includeImage =
        Boolean(options.llmEnabled) &&
        (visionMode === "always" || navigatedSinceLastStep);

      let prompt: string;
      if (options.llmEnabled) {
        // 使用 LlmStrategist 构建增强 prompt
        const visitedStateTypes = stateMachine
          .getVisitedStates()
          .map((s) => s.stateType)
          .filter((v, i, a) => a.indexOf(v) === i);
        const anomalyWarnings: string[] = [];
        if (enableAnomaly) {
          const summary = anomalyDetector.getSummary();
          if (summary !== "无异常") {
            anomalyWarnings.push(`Recent anomalies: ${summary}`);
          }
        }

        const enhancedContext = llmStrategist.buildContext({
          pageContext: context,
          currentState: stateNode,
          stateTransitions: stateMachine.getTransitions(),
          formSchemas,
          fillProgress,
          visitedStates: visitedStateTypes,
          anomalyWarnings,
        });
        prompt = llmStrategist.buildUserPrompt(enhancedContext, includeImage);
      } else {
        // 回退到原有 prompt
        prompt = buildPrompt(context, includeImage, conversationMessages.length);
      }

      console.log(`[explorer] step ${step} 发送给 LLM，includeImage=${includeImage}, state=${stateNode.stateType}, forms=${formSchemas.length}`);

      if (llmConversationEnabled) {
        conversationMessages.push({ role: "user", content: prompt });
      }

      // ── 7. 调用 LLM ──
      const raw = options.llmEnabled
        ? await callLlm(
            llmConversationEnabled ? conversationMessages : [{ role: "user", content: prompt }],
            options.llmApiKey,
            options.llmEndpoint,
            options.llmModel ?? "gpt-4o-mini",
            context.screenshotPath,
            includeImage
          )
        : null;

      if (llmConversationEnabled && raw) {
        conversationMessages.push({ role: "assistant", content: raw });
      }

      console.log(`[explorer] step ${step} LLM raw length=${raw?.length ?? 0}`);
      const llmAction = parseLlmAction(raw);
      console.log(`[explorer] step ${step} LLM action: ${llmAction ? llmAction.action : "fallback"}`);

      // ── 8. 执行动作 ──
      let log = llmAction ? await executeAction(page, llmAction, context, rng, step) : null;
      if (!log) {
        console.warn(`[explorer] step ${step} LLM 动作不可执行，改用随机兜底动作`);
        log = await fallbackRandomStep(page, rng, step, options.maxInputsPerPage ?? 10);
      }

      if (!log) {
        console.warn(`[explorer] step ${step} 未能执行任何动作，停止`);
        break;
      }
      logs.push(log);

      // ── 9. 等待页面响应 ──
      await page.waitForTimeout(options.waitAfterActionMs ?? 300);
      if (page.isClosed()) {
        console.warn("[explorer] 页面已关闭");
        break;
      }

      // ── 10. 异常检测 [新增] ──
      if (enableAnomaly) {
        const anomalies = await anomalyDetector.check(page, step, context.screenshotPath);
        if (anomalies.length > 0) {
          console.warn(
            `[explorer] step ${step} 检测到 ${anomalies.length} 个异常: ${anomalies.map((a) => a.type).join(", ")}`
          );

          // 严重异常 → 尝试回溯
          if (anomalyDetector.hasSevereAnomaly()) {
            console.warn(`[explorer] step ${step} 严重异常，尝试回溯...`);
            const result = await backtracker.recover(page, step);
            console.log(`[explorer] 回溯结果: recovered=${result.recovered}, ${result.message}`);

            if (result.recovered) {
              // 回溯成功后记录转移
              const newUrl = page.url();
              const newFingerprint = stateMachine.fingerprint(
                newUrl,
                await page.title().catch(() => ""),
                await formAnalyzer.analyze(page),
                []
              );
              stateMachine.registerState(newFingerprint, step);
              stateMachine.transition(fingerprint, newFingerprint, step, "back");
              // 重置异常检测器
              if (!page.isClosed()) {
                anomalyDetector.attach(page, options.url);
              }
            } else {
              console.warn(`[explorer] step ${step} 回溯失败，跳过此步继续`);
            }

            // 记录转移
            stateMachine.transition(
              fingerprint,
              stateMachine.getCurrentState()?.fingerprint ?? fingerprint,
              step,
              log.type
            );
            continue;
          }
        } else {
          // 无异常 → 重置回溯计数
          backtracker.resetBacktrackCount();
        }
      }

      // ── 11. 记录状态转移 [新增] ──
      const afterUrl = page.url();
      if (afterUrl !== context.url) {
        const afterForms = await formAnalyzer.analyze(page);
        const afterKeyTexts = await page
          .evaluate(() =>
            Array.from(document.querySelectorAll("button, a, [role='button'], h1, h2, h3"))
              .map((el) => (el.textContent || "").trim().slice(0, 50))
              .filter(Boolean)
              .slice(0, 10)
          )
          .catch(() => [] as string[]);
        const afterFingerprint = stateMachine.fingerprint(
          afterUrl,
          await page.title().catch(() => ""),
          afterForms,
          afterKeyTexts
        );
        stateMachine.registerState(afterFingerprint, step);
        stateMachine.transition(fingerprint, afterFingerprint, step, log.type);
      }

      console.log(`[explorer] step ${step} 完成`);
    }

    // ── 输出总结 ──
    console.log("\n[explorer] ====== 探索总结 ======");
    console.log(`[explorer] 状态机: ${stateMachine.getSummary()}`);
    console.log(`[explorer] 回溯: ${backtracker.getSummary()}`);
    if (enableAnomaly) {
      const allAnomalies = anomalyDetector.getAllAnomalies();
      console.log(`[explorer] 异常总数: ${allAnomalies.length}`);
      if (allAnomalies.length > 0) {
        for (const a of allAnomalies) {
          console.log(`[explorer]   - step${a.step} [${a.type}] ${a.message.slice(0, 100)}`);
        }
      }
    }
  } finally {
    console.log("[explorer] 关闭浏览器");
    await browser.close();
  }

  return logs;
}
