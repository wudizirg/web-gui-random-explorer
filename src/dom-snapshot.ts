/**
 * dom-snapshot.ts — DOM 快照捕获与保存
 *
 * 功能：
 * - 捕获页面简化 DOM 树
 * - 序列化为 JSON 保存
 * - 前后步 DOM 对比（简要 diff）
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import type { DomSnapshotRecord, DomElementNode, FormSchema } from "./types.js";

/** 简化 DOM 节点：递归提取关键信息 */
function simplifyNode(el: Element, depth: number = 0): DomElementNode | null {
  if (depth > 8) return null; // 限制深度

  const tag = el.tagName.toLowerCase();

  // 跳过 script / style / noscript / svg
  if (["script", "style", "noscript", "svg", "path", "meta", "link"].includes(tag)) {
    return null;
  }

  // 提取关键属性
  const attrs: Record<string, string> = {};
  const importantAttrs = [
    "id", "name", "type", "placeholder", "role", "aria-label",
    "href", "action", "method", "value", "checked", "disabled",
    "required", "aria-required", "class", "data-gui-explorer-id",
    "data-gui-explorer-filled",
  ];
  for (const attr of importantAttrs) {
    const val = el.getAttribute(attr);
    if (val !== null && val !== "") {
      attrs[attr] = val.length > 100 ? val.slice(0, 100) + "..." : val;
    }
  }

  // 直接文本内容（不含子元素文本）
  let directText = "";
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      directText += (child.textContent || "");
    }
  }
  directText = directText.trim().slice(0, 200);

  // 构建选择器
  let selector = tag;
  if (el.id) selector = `#${el.id}`;
  else if (attrs["data-gui-explorer-id"])
    selector = `[data-gui-explorer-id="${attrs["data-gui-explorer-id"]}"]`;

  // 递归处理子元素
  const children: DomElementNode[] = [];
  if (depth < 6 && el.children.length > 0) {
    for (const child of el.children) {
      const simplified = simplifyNode(child, depth + 1);
      if (simplified) {
        children.push(simplified);
      }
    }
  }

  // 跳过空的叶子节点
  if (!directText && children.length === 0 && Object.keys(attrs).length === 0) {
    return null;
  }

  return { tag, attributes: attrs, text: directText, children, selector };
}

/** 计算 DOM 树的节点数 */
function countNodes(node: DomElementNode): number {
  let count = 1;
  for (const child of node.children) {
    count += countNodes(child);
  }
  return count;
}

/** 简单 diff：比较两棵 DOM 树的主要差异 */
function simpleDiff(
  prev: DomElementNode | null,
  curr: DomElementNode | null
): string[] {
  const diffs: string[] = [];
  if (!prev && curr) {
    diffs.push(`新增根节点: ${curr.tag}`);
    return diffs;
  }
  if (prev && !curr) {
    diffs.push(`移除根节点: ${prev.tag}`);
    return diffs;
  }
  if (!prev || !curr) return diffs;

  const prevCount = countNodes(prev);
  const currCount = countNodes(curr);
  if (prevCount !== currCount) {
    diffs.push(
      `DOM 节点数变化: ${prevCount} → ${currCount} (${currCount - prevCount > 0 ? "+" : ""}${currCount - prevCount})`
    );
  }

  // 比较表单元素变化
  const prevForms = collectFormElements(prev);
  const currForms = collectFormElements(curr);
  const added = currForms.filter((f) => !prevForms.includes(f));
  const removed = prevForms.filter((f) => !currForms.includes(f));
  if (added.length > 0) diffs.push(`新增元素: ${added.join(", ")}`);
  if (removed.length > 0) diffs.push(`移除元素: ${removed.join(", ")}`);

  return diffs;
}

function collectFormElements(node: DomElementNode): string[] {
  const formTags = ["input", "textarea", "select", "button", "form"];
  const results: string[] = [];
  if (formTags.includes(node.tag)) {
    const name =
      node.attributes["name"] ||
      node.attributes["id"] ||
      node.attributes["placeholder"] ||
      node.tag;
    results.push(name);
  }
  for (const child of node.children) {
    results.push(...collectFormElements(child));
  }
  return results;
}

export class DomSnapshot {
  private previousSnapshot: DomSnapshotRecord | null = null;

  /**
   * 捕获当前页面的 DOM 快照
   */
  async capture(
    page: Page,
    step: number,
    forms: FormSchema[],
    elementsSummary: string
  ): Promise<DomSnapshotRecord> {
    const url = page.url();
    const title = await page.title().catch(() => "");

    const bodyTree = await page
      .evaluate((simplifyFn) => {
        // eval 传递函数体
        const fn = new Function("el", "depth", `
          const tag = el.tagName.toLowerCase();
          if (["script","style","noscript","svg","path","meta","link"].includes(tag)) return null;
          if (depth > 8) return null;
          const attrs = {};
          const importantAttrs = ["id","name","type","placeholder","role","aria-label","href","action","method","value","checked","disabled","required","aria-required","class","data-gui-explorer-id","data-gui-explorer-filled"];
          for (const attr of importantAttrs) {
            const val = el.getAttribute(attr);
            if (val !== null && val !== "") attrs[attr] = val.length > 100 ? val.slice(0,100)+"..." : val;
          }
          let directText = "";
          for (const child of el.childNodes) {
            if (child.nodeType === 3) directText += (child.textContent || "");
          }
          directText = directText.trim().slice(0, 200);
          let selector = tag;
          if (el.id) selector = "#"+el.id;
          else if (attrs["data-gui-explorer-id"]) selector = '[data-gui-explorer-id="'+attrs["data-gui-explorer-id"]+'"]';
          const children = [];
          if (depth < 6 && el.children.length > 0) {
            for (const child of el.children) {
              const s = arguments.callee(child, depth+1);
              if (s) children.push(s);
            }
          }
          if (!directText && children.length===0 && Object.keys(attrs).length===0) return null;
          return {tag,attributes:attrs,text:directText,children,selector};
        `);
        return fn(document.body, 0);
      })
      .catch(() => null);

    const record: DomSnapshotRecord = {
      step,
      url,
      title,
      timestamp: new Date().toISOString(),
      bodyTree: bodyTree || {
        tag: "body",
        attributes: {},
        text: "(capture failed)",
        children: [],
        selector: "body",
      },
      elementsSummary,
      forms,
    };

    return record;
  }

  /**
   * 保存快照到文件
   */
  async save(snapshotDir: string, record: DomSnapshotRecord): Promise<string> {
    await mkdir(snapshotDir, { recursive: true });
    const filePath = path.join(
      snapshotDir,
      `dom-step-${String(record.step).padStart(3, "0")}.json`
    );
    await writeFile(filePath, JSON.stringify(record, null, 2), "utf-8");
    return filePath;
  }

  /**
   * 与上一步快照对比
   */
  diff(prev: DomSnapshotRecord | null, curr: DomSnapshotRecord): string[] {
    if (!prev) return ["(首次快照，无对比)"];
    if (prev.url !== curr.url) {
      return [`页面 URL 变化: ${prev.url} → ${curr.url}`];
    }
    return simpleDiff(prev.bodyTree, curr.bodyTree);
  }

  /** 获取上一步快照 */
  getPrevious(): DomSnapshotRecord | null {
    return this.previousSnapshot;
  }

  /** 更新上一步快照 */
  setPrevious(snapshot: DomSnapshotRecord): void {
    this.previousSnapshot = snapshot;
  }
}
