/**
 * anomaly-detector.ts — 异常检测器
 *
 * 功能：
 * - 监听 console.error / 未捕获 JS 异常
 * - 检测页面崩溃
 * - 检测 HTTP 错误状态（4xx/5xx）
 * - 检测空白页面
 * - 检测意外导航
 */
import type { Page, ConsoleMessage } from "playwright";
import type { AnomalyRecord, AnomalyType } from "./types.js";

export class AnomalyDetector {
  private anomalies: AnomalyRecord[] = [];
  private jsErrors: string[] = [];
  private consoleErrors: string[] = [];
  private crashed = false;
  private expectedOrigin: string = "";

  /**
   * 附加到页面，开始监听
   */
  attach(page: Page, expectedUrl: string): void {
    this.anomalies = [];
    this.jsErrors = [];
    this.consoleErrors = [];
    this.crashed = false;

    try {
      this.expectedOrigin = new URL(expectedUrl).origin;
    } catch {
      this.expectedOrigin = expectedUrl;
    }

    // 监听控制台 error
    page.on("console", (msg: ConsoleMessage) => {
      if (msg.type() === "error") {
        const text = msg.text();
        this.consoleErrors.push(text);
        console.warn(`[anomaly] console.error: ${text.slice(0, 200)}`);
      }
    });

    // 监听未捕获异常
    page.on("pageerror", (error: Error) => {
      const msg = error.message || String(error);
      this.jsErrors.push(msg);
      console.warn(`[anomaly] pageerror: ${msg.slice(0, 200)}`);
    });

    // 监听页面崩溃
    page.on("crash", () => {
      this.crashed = true;
      console.error("[anomaly] 页面崩溃！");
    });
  }

  /**
   * 每步执行后检测异常
   */
  async check(
    page: Page,
    step: number,
    screenshotPath: string
  ): Promise<AnomalyRecord[]> {
    const stepAnomalies: AnomalyRecord[] = [];
    const url = page.url();
    const timestamp = new Date().toISOString();

    // 1. 检查页面崩溃
    if (this.crashed) {
      stepAnomalies.push({
        step,
        type: "page-crash",
        message: "页面已崩溃",
        url,
        timestamp,
        screenshotPath,
      });
      return stepAnomalies;
    }

    // 2. 检查 JS 错误
    for (const err of this.jsErrors.splice(0)) {
      stepAnomalies.push({
        step,
        type: "js-error",
        message: err,
        url,
        timestamp,
        screenshotPath,
        details: "未捕获的 JS 异常",
      });
    }

    // 3. 检查 console.error
    for (const err of this.consoleErrors.splice(0)) {
      stepAnomalies.push({
        step,
        type: "console-error",
        message: err,
        url,
        timestamp,
        screenshotPath,
        details: "console.error 调用",
      });
    }

    // 4. 检测 HTTP 错误（通过页面文本内容）
    try {
      const bodyText = await page
        .evaluate(() => document.body.innerText.slice(0, 500))
        .catch(() => "");
      const title = await page.title().catch(() => "");

      const httpErrorPatterns: Array<{ pattern: RegExp; label: string }> = [
        { pattern: /404.*not\s*found/i, label: "404 Not Found" },
        { pattern: /500.*internal\s*server/i, label: "500 Internal Server Error" },
        { pattern: /403.*forbidden/i, label: "403 Forbidden" },
        { pattern: /502.*bad\s*gateway/i, label: "502 Bad Gateway" },
        { pattern: /503.*service\s*unavailable/i, label: "503 Service Unavailable" },
        { pattern: /页面(不存在|未找到|已失效)/i, label: "页面不存在（中文）" },
        { pattern: /服务器(错误|异常)/i, label: "服务器错误（中文）" },
      ];

      for (const { pattern, label } of httpErrorPatterns) {
        if (pattern.test(bodyText) || pattern.test(title)) {
          stepAnomalies.push({
            step,
            type: "http-error",
            message: label,
            url,
            timestamp,
            screenshotPath,
            details: bodyText.slice(0, 200),
          });
          break; // 只报告第一个匹配的
        }
      }
    } catch {
      // bodyText 获取失败
    }

    // 5. 检测空白页面
    try {
      const hasContent = await page
        .evaluate(() => {
          const body = document.body;
          if (!body) return false;
          const text = body.innerText?.trim() || "";
          const children = body.children.length;
          // 至少有一些文本或子元素
          return text.length > 5 || children > 2;
        })
        .catch(() => true);

      if (!hasContent && !page.isClosed()) {
        stepAnomalies.push({
          step,
          type: "blank-page",
          message: "页面内容过少，可能为空白页",
          url,
          timestamp,
          screenshotPath,
        });
      }
    } catch {
      // ignore
    }

    // 6. 检测意外导航离开
    try {
      if (this.expectedOrigin && !page.isClosed()) {
        const currentOrigin = new URL(url).origin;
        if (
          currentOrigin !== this.expectedOrigin &&
          !url.startsWith("about:") &&
          !url.startsWith("data:")
        ) {
          stepAnomalies.push({
            step,
            type: "navigation-loss",
            message: `导航到外部站点: ${url}`,
            url,
            timestamp,
            screenshotPath,
          });
        }
      }
    } catch {
      // ignore
    }

    this.anomalies.push(...stepAnomalies);
    return stepAnomalies;
  }

  /**
   * 检查页面是否被关闭
   */
  isPageClosed(page: Page): boolean {
    return page.isClosed() || this.crashed;
  }

  /**
   * 获取所有已记录的异常
   */
  getAllAnomalies(): AnomalyRecord[] {
    return [...this.anomalies];
  }

  /**
   * 是否有严重异常（需要回溯的）
   */
  hasSevereAnomaly(): boolean {
    return this.anomalies.some((a) =>
      ["page-crash", "http-error", "blank-page", "navigation-loss"].includes(
        a.type
      )
    );
  }

  /**
   * 异常摘要（供 LLM prompt 使用）
   */
  getSummary(): string {
    if (this.anomalies.length === 0) return "无异常";
    const byType: Record<string, number> = {};
    for (const a of this.anomalies) {
      byType[a.type] = (byType[a.type] || 0) + 1;
    }
    return Object.entries(byType)
      .map(([type, count]) => `${type}: ${count}次`)
      .join(", ");
  }
}
