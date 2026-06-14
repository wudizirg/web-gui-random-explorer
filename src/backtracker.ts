/**
 * backtracker.ts — 状态回溯管理器
 *
 * 功能：
 * - 保存每步的状态快照（URL + 指纹 + 截图路径）
 * - 异常时自动回溯到上一个已知良好状态
 * - 限制回溯次数，防止无限循环
 */
import type { Page } from "playwright";
import type {
  BacktrackSnapshot,
  BacktrackResult,
  PageFingerprint,
} from "./types.js";

export class Backtracker {
  private snapshots: BacktrackSnapshot[] = [];
  private maxBacktrack: number;
  private backtrackCount = 0;

  constructor(maxBacktrack = 3) {
    this.maxBacktrack = maxBacktrack;
  }

  /**
   * 保存当前状态快照
   */
  saveSnapshot(
    step: number,
    url: string,
    fingerprint: PageFingerprint,
    screenshotPath: string,
    domSnapshotPath?: string
  ): void {
    this.snapshots.push({
      step,
      url,
      fingerprint,
      screenshotPath,
      domSnapshotPath,
    });
    // 只保留最近 20 个快照
    if (this.snapshots.length > 20) {
      this.snapshots.shift();
    }
  }

  /**
   * 获取最近的快照
   */
  getLatestSnapshot(): BacktrackSnapshot | null {
    return this.snapshots.length > 0
      ? this.snapshots[this.snapshots.length - 1]
      : null;
  }

  /**
   * 获取倒数第 N 个快照
   */
  getPreviousSnapshot(stepsBack = 1): BacktrackSnapshot | null {
    const idx = this.snapshots.length - 1 - stepsBack;
    return idx >= 0 ? this.snapshots[idx] : null;
  }

  /**
   * 尝试回溯
   * 策略：优先 goBack()，失败则直接导航到上一个已知 URL
   */
  async recover(
    page: Page,
    currentStep: number
  ): Promise<BacktrackResult> {
    if (this.backtrackCount >= this.maxBacktrack) {
      return {
        recovered: false,
        newStep: currentStep,
        attempts: this.backtrackCount,
        message: `已达到最大回溯次数限制 (${this.maxBacktrack})`,
      };
    }

    this.backtrackCount += 1;
    console.log(
      `[backtracker] 尝试回溯 (${this.backtrackCount}/${this.maxBacktrack})`
    );

    // 获取上一个快照
    const prevSnapshot = this.getPreviousSnapshot(this.backtrackCount);
    if (!prevSnapshot) {
      console.warn("[backtracker] 没有可用的回溯快照");
      return {
        recovered: false,
        newStep: currentStep,
        attempts: this.backtrackCount,
        message: "没有可用的回溯快照",
      };
    }

    try {
      // 策略 1: 尝试浏览器后退
      try {
        await page.goBack({ waitUntil: "domcontentloaded", timeout: 8000 });
        const newUrl = page.url();

        // 检查是否恢复到目标 URL
        if (newUrl === prevSnapshot.url || new URL(newUrl).pathname === new URL(prevSnapshot.url).pathname) {
          console.log(`[backtracker] goBack() 成功: ${newUrl}`);
          return {
            recovered: true,
            newStep: currentStep,
            attempts: this.backtrackCount,
            message: `goBack() 恢复到 ${newUrl}`,
          };
        }
      } catch {
        console.warn("[backtracker] goBack() 失败，尝试直接导航");
      }

      // 策略 2: 直接导航到上一快照 URL
      try {
        await page.goto(prevSnapshot.url, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });
        console.log(`[backtracker] 直接导航成功: ${prevSnapshot.url}`);
        return {
          recovered: true,
          newStep: currentStep,
          attempts: this.backtrackCount,
          message: `直接导航恢复到 ${prevSnapshot.url}`,
        };
      } catch {
        console.warn("[backtracker] 直接导航也失败");
        return {
          recovered: false,
          newStep: currentStep,
          attempts: this.backtrackCount,
          message: "goBack() 和直接导航均失败",
        };
      }
    } catch (error) {
      console.error("[backtracker] 回溯异常:", error);
      return {
        recovered: false,
        newStep: currentStep,
        attempts: this.backtrackCount,
        message: `回溯异常: ${String(error)}`,
      };
    }
  }

  /**
   * 重置回溯计数（探索顺利时调用）
   */
  resetBacktrackCount(): void {
    if (this.backtrackCount > 0) {
      console.log(`[backtracker] 回溯计数已重置 (之前: ${this.backtrackCount})`);
    }
    this.backtrackCount = 0;
  }

  /**
   * 获取回溯次数
   */
  getBacktrackCount(): number {
    return this.backtrackCount;
  }

  /**
   * 获取所有快照
   */
  getSnapshots(): BacktrackSnapshot[] {
    return [...this.snapshots];
  }

  /**
   * 回溯摘要（供日志使用）
   */
  getSummary(): string {
    return `快照数: ${this.snapshots.length}, 回溯次数: ${this.backtrackCount}/${this.maxBacktrack}`;
  }
}
