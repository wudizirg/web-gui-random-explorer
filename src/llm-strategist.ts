/**
 * llm-strategist.ts — 增强 LLM 策略层
 *
 * 功能：
 * - 构建包含状态感知和表单结构的增强 Prompt
 * - 解析 LLM 多步规划输出
 * - 验证步骤执行结果
 */
import type {
  PageContext,
  PageStateNode,
  StateTransition,
  FormSchema,
  StrategyPlan,
  PlannedStep,
  LlmEnhancedContext,
  ActionType,
  PageStateType,
} from "./types.js";

export class LlmStrategist {
  /**
   * 构建增强的系统提示词
   */
  buildSystemPrompt(): string {
    return [
      "You are an intelligent browser automation assistant for GUI testing.",
      "Your goal is to systematically explore web pages, fill forms, and discover states.",
      "",
      "Core rules:",
      "- Output ONLY one JSON object per response.",
      "- Prefer precise CSS selectors over targetIndex.",
      "- Fill forms in natural reading order: username → password → email → other fields.",
      "- If a field is already filled (marked ✓done), skip it and move to the next.",
      "- After filling all required fields, click the submit button.",
      "- On error pages or unexpected states, try to go back or recover.",
      "- If the page is blank or broken, use 'back' or 'wait'.",
      "",
      "Form-filling strategy:",
      "- Treat this as a multi-step stateful task.",
      "- Fill exactly ONE input per step.",
      "- Do NOT repeat already-filled fields.",
      "- Login pages: username → password → submit.",
      "- Registration pages: username → email → password → confirm password → submit.",
      "- Search forms: search query → submit.",
    ].join("\n");
  }

  /**
   * 构建增强的用户 prompt（包含状态、表单、异常信息）
   */
  buildUserPrompt(context: LlmEnhancedContext, imageAttached: boolean): string {
    const { pageContext, currentState, formSchemas, fillProgress, visitedStates, anomalyWarnings } = context;

    const parts: string[] = [];

    // 视觉提示
    parts.push(
      imageAttached
        ? "📸 A screenshot is attached. Use it with the element list below."
        : "📋 No screenshot this step (same URL). Rely on the element list."
    );

    // 页面信息
    parts.push(`\n## Current Page`);
    parts.push(`- URL: ${pageContext.url}`);
    parts.push(`- Title: ${pageContext.title}`);

    // 状态信息
    if (currentState) {
      parts.push(`\n## Current State`);
      parts.push(`- State type: ${currentState.stateType}`);
      parts.push(`- Visit count: ${currentState.visitCount}`);
      parts.push(`- First seen at step: ${currentState.firstSeenAt}`);
    }

    // 已访问状态
    if (visitedStates.length > 0) {
      parts.push(`- Previously visited states: ${visitedStates.join(", ")}`);
    }

    // 表单结构
    if (formSchemas.length > 0) {
      parts.push(`\n## Form Structure`);
      for (const schema of formSchemas) {
        parts.push(`### Form: ${schema.formSelector}`);
        parts.push(`| # | Field | Type | Required | Status |`);
        parts.push(`|---|-------|------|----------|--------|`);
        for (let i = 0; i < schema.fields.length; i++) {
          const f = schema.fields[i];
          const status = f.filled ? "✓ done" : "○ pending";
          parts.push(
            `| ${i + 1} | ${f.label} | ${f.type} | ${f.required ? "YES" : "no"} | ${status} |`
          );
        }
        if (schema.submitSelector) {
          parts.push(`\nSubmit button: \`${schema.submitSelector}\``);
        }
      }
    }

    // 填充进度
    if (fillProgress) {
      parts.push(`\n## Fill Progress\n${fillProgress}`);
    }

    // 异常警告
    if (anomalyWarnings.length > 0) {
      parts.push(`\n## ⚠️ Anomaly Warnings`);
      for (const w of anomalyWarnings) {
        parts.push(`- ${w}`);
      }
      parts.push(`Consider using 'back' or 'wait' to recover.`);
    }

    // 元素列表
    parts.push(`\n## Interactive Elements`);
    parts.push(pageContext.elementsSummary || "- none detected");

    // 能力
    parts.push(`\n## Available Actions`);
    parts.push(`Capabilities: ${pageContext.capabilities.join(", ")}`);

    // 索引范围
    const clickHi = pageContext.clickableCount > 0 ? pageContext.clickableCount - 1 : -1;
    const inputLo = pageContext.clickableCount;
    const inputHi = pageContext.inputCount > 0 ? pageContext.clickableCount + pageContext.inputCount - 1 : -1;
    if (pageContext.clickableCount > 0 || pageContext.inputCount > 0) {
      parts.push(
        `Click indices: ${pageContext.clickableCount > 0 ? `0..${clickHi}` : "none"}`
      );
      parts.push(
        `Input indices: ${pageContext.inputCount > 0 ? `${inputLo}..${inputHi}` : "none"}`
      );
    }

    // 输出格式
    parts.push(`\n## Output`);
    parts.push(
      `Return exactly one JSON object (no markdown, no code fences):`
    );
    parts.push(
      `{"action":"click|input|scroll|back|wait","selector":"css selector","value":"...","amount":600,"reason":"..."}`
    );

    return parts.join("\n");
  }

  /**
   * 尝试解析多步规划（如果 LLM 返回了多步计划）
   */
  parseMultiStepPlan(raw: string, contextUrl: string): StrategyPlan | null {
    try {
      // 检查是否包含多步计划标记
      if (!raw.includes('"steps"') || !raw.includes('"goal"')) {
        return null;
      }

      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start < 0 || end < 0) return null;

      const parsed = JSON.parse(raw.slice(start, end + 1));
      if (!Array.isArray(parsed.steps) || !parsed.goal) return null;

      const steps: PlannedStep[] = parsed.steps.map((s: Record<string, unknown>) => ({
        action: (s.action as ActionType) || "click",
        selector: s.selector as string | undefined,
        value: s.value as string | undefined,
        amount: s.amount as number | undefined,
        reason: (s.reason as string) || "",
        expectedState: s.expectedState as PlannedStep["expectedState"],
      }));

      return {
        steps,
        goal: parsed.goal as string,
        contextUrl,
      };
    } catch {
      return null;
    }
  }

  /**
   * 构建增强上下文
   */
  buildContext(params: {
    pageContext: PageContext;
    currentState: PageStateNode | null;
    stateTransitions: StateTransition[];
    formSchemas: FormSchema[];
    fillProgress: string;
    visitedStates: PageStateType[];
    anomalyWarnings: string[];
  }): LlmEnhancedContext {
    return {
      pageContext: params.pageContext,
      currentState: params.currentState,
      stateHistory: params.stateTransitions,
      formSchemas: params.formSchemas,
      fillProgress: params.fillProgress,
      visitedStates: params.visitedStates,
      anomalyWarnings: params.anomalyWarnings,
    };
  }
}
