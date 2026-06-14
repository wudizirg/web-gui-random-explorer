/**
 * form-analyzer.ts — 表单结构感知
 *
 * 功能：
 * - 识别页面中的 <form> 结构
 * - 解析表单字段（类型、必填状态、label 关联）
 * - 输出结构化 FormSchema
 * - 生成表单填充进度摘要
 */
import type { Page, ElementHandle } from "playwright";
import type { FormSchema, FormField } from "./types.js";

const FILLED_ATTR = "data-gui-explorer-filled";

/** 根据 tag 和属性推断字段的语义类型 */
function inferFieldType(
  tag: string,
  typeAttr: string | null,
  role: string | null
): string {
  if (tag === "textarea") return "textarea";
  if (tag === "select") return "select";
  if (role === "checkbox" || typeAttr === "checkbox") return "checkbox";
  if (role === "radio" || typeAttr === "radio") return "radio";
  return typeAttr || "text";
}

export class FormAnalyzer {
  /**
   * 分析页面中所有表单结构
   */
  async analyze(page: Page): Promise<FormSchema[]> {
    const schemas: FormSchema[] = [];

    try {
      // 查找所有 form 元素
      const formHandles = await page.$$("form");
      const processedSelectors = new Set<string>();

      for (let fi = 0; fi < formHandles.length; fi++) {
        const formHandle = formHandles[fi];
        try {
          const schema = await this.analyzeForm(page, formHandle, fi, processedSelectors);
          if (schema) {
            schemas.push(schema);
          }
        } catch {
          // 跳过解析失败的表单
        }
      }

      // 处理无 <form> 包裹的独立输入字段组
      if (schemas.length === 0) {
        const orphanSchema = await this.analyzeOrphanInputs(page, processedSelectors);
        if (orphanSchema) {
          schemas.push(orphanSchema);
        }
      }
    } catch (error) {
      console.warn("[form-analyzer] 分析失败:", error);
    }

    return schemas;
  }

  private async analyzeForm(
    page: Page,
    formHandle: ElementHandle,
    index: number,
    processedSelectors: Set<string>
  ): Promise<FormSchema | null> {
    const fields: FormField[] = [];

    // 获取 form 属性
    const action = await formHandle.getAttribute("action").catch(() => null);
    const formId = await formHandle.getAttribute("id").catch(() => null);
    const formName = await formHandle.getAttribute("name").catch(() => null);
    const formSelector = formId
      ? `#${formId}`
      : formName
        ? `form[name="${formName}"]`
        : `form:nth-of-type(${index + 1})`;

    // 查找表单内的输入元素
    const inputElements = await formHandle
      .$$(
        'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), [contenteditable="true"]'
      )
      .catch(() => []);

    for (const el of inputElements) {
      try {
        const field = await this.extractField(page, el, formSelector);
        if (field) {
          processedSelectors.add(field.selector);
          fields.push(field);
        }
      } catch {
        // 跳过单个字段解析失败
      }
    }

    if (fields.length === 0) return null;

    // 查找提交按钮
    const submitBtn = await formHandle
      .$(
        'button[type="submit"], input[type="submit"], button:not([type]), [role="button"]'
      )
      .catch(() => null);
    const submitSelector = submitBtn
      ? await submitBtn
          .evaluate((el) => {
            const e = el as HTMLElement;
            if (e.id) return `#${e.id}`;
            if (e.getAttribute("name")) return `[name="${e.getAttribute("name")}"]`;
            const text = (e.textContent || "").trim().slice(0, 30);
            return `button:has-text("${text.replace(/"/g, '\\"')}")`;
          })
          .catch(() => undefined)
      : undefined;

    return {
      formSelector,
      action: action ?? undefined,
      fields,
      submitSelector,
      index,
    };
  }

  /**
   * 处理没有 <form> 包裹的独立输入
   */
  private async analyzeOrphanInputs(
    page: Page,
    processedSelectors: Set<string>
  ): Promise<FormSchema | null> {
    const fields: FormField[] = [];

    const inputElements = await page
      .$$(
        'input:not([type="hidden"]):not([disabled]):not(form input), textarea:not([disabled]):not(form textarea), select:not([disabled]):not(form select)'
      )
      .catch(() => []);

    for (const el of inputElements.slice(0, 10)) {
      try {
        const field = await this.extractField(page, el, "body");
        if (field && !processedSelectors.has(field.selector)) {
          fields.push(field);
        }
      } catch {
        // 跳过
      }
    }

    if (fields.length === 0) return null;
    return {
      formSelector: "body",
      fields,
      index: 0,
    };
  }

  private async extractField(
    page: Page,
    el: ElementHandle,
    formSelector: string
  ): Promise<FormField | null> {
    const tagName = await el
      .evaluate((e) => (e as HTMLElement).tagName.toLowerCase())
      .catch(() => "input");

    const typeAttr = await el.getAttribute("type").catch(() => null);
    const role = await el.getAttribute("role").catch(() => null);
    const nameAttr = await el.getAttribute("name").catch(() => null);
    const idAttr = await el.getAttribute("id").catch(() => null);
    const placeholder = await el.getAttribute("placeholder").catch(() => null);
    const required =
      (await el.getAttribute("required").catch(() => null)) !== null ||
      (await el.getAttribute("aria-required").catch(() => null)) === "true";

    // 尝试找到关联的 label
    let labelText = nameAttr || "";
    if (idAttr) {
      try {
        const labelEl = await page.$(`label[for="${idAttr}"]`);
        if (labelEl) {
          const text = await labelEl.textContent().catch(() => "");
          if (text && text.trim()) labelText = text.trim().slice(0, 60);
        }
      } catch {
        // ignore
      }
    }

    // 如果没有 label，使用 placeholder 或 name
    if (!labelText && placeholder) labelText = placeholder;
    if (!labelText) labelText = tagName;

    // 构建稳定选择器
    const selector = idAttr
      ? `#${idAttr}`
      : nameAttr
        ? `${tagName}[name="${nameAttr.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`
        : `${tagName}[placeholder="${(placeholder || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;

    // 检查是否已填写
    const filled =
      (await el
        .evaluate((e) => {
          const elm = e as HTMLInputElement;
          return Boolean(elm.value || elm.getAttribute(FILLED_ATTR));
        })
        .catch(() => false)) || false;

    const type = inferFieldType(tagName, typeAttr, role);

    return {
      label: labelText,
      type,
      required,
      selector,
      filled,
      placeholder: placeholder ?? undefined,
      formSelector,
    };
  }

  /**
   * 生成表单填充进度摘要（供 LLM prompt 使用）
   */
  fillProgressSummary(schemas: FormSchema[]): string {
    if (schemas.length === 0) return "未检测到表单";

    const lines: string[] = [];
    for (const schema of schemas) {
      const total = schema.fields.length;
      const filled = schema.fields.filter((f) => f.filled).length;
      const requiredCount = schema.fields.filter((f) => f.required).length;
      const requiredFilled = schema.fields.filter(
        (f) => f.required && f.filled
      ).length;

      lines.push(`表单 ${schema.formSelector}:`);
      lines.push(
        `  进度: ${filled}/${total} 已填 (${requiredFilled}/${requiredCount} 必填)`
      );

      const unfinished = schema.fields.filter((f) => !f.filled);
      if (unfinished.length > 0) {
        lines.push("  待填写:");
        for (const f of unfinished.slice(0, 5)) {
          const req = f.required ? " [必填]" : "";
          lines.push(`    - ${f.label} (${f.type})${req} → ${f.selector}`);
        }
      }

      if (schema.submitSelector) {
        lines.push(`  提交按钮: ${schema.submitSelector}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * 生成表单结构文本（供 LLM prompt 使用）
   */
  describeForLlm(schemas: FormSchema[]): string {
    if (schemas.length === 0) return "No forms detected on this page.";

    const lines: string[] = [];
    for (const schema of schemas) {
      lines.push(`Form ${schema.formSelector}:`);
      const fieldDescs = schema.fields.map((f, i) => {
        const req = f.required ? "required" : "optional";
        const done = f.filled ? " ✓(done)" : "";
        return `  ${i + 1}. ${f.label} [${f.type}, ${req}]${done}`;
      });
      lines.push(fieldDescs.join("\n"));
      if (schema.submitSelector) {
        lines.push(`  → submit: ${schema.submitSelector}`);
      }
    }
    return lines.join("\n");
  }
}
