/**
 * state-machine.ts — 页面状态机
 *
 * 功能：
 * - 计算页面指纹（URL 路径 + 表单签名 + 关键元素 hash）
 * - 分类页面状态类型（login / form / content / error 等）
 * - 记录状态转移历史
 * - 判断是否为新状态
 */
import type {
  PageFingerprint,
  PageStateType,
  StateTransition,
  PageStateNode,
  FormSchema,
} from "./types.js";

/** 提取 URL 路径部分（去掉 query 和 hash） */
function extractUrlPath(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

/** 简单字符串 hash（djb2） */
function hashString(s: string): string {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 33) ^ s.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

export class PageStateMachine {
  private states: PageStateNode[] = [];
  private transitions: StateTransition[] = [];
  private knownFingerprints = new Set<string>();

  /** 计算页面指纹 */
  fingerprint(
    url: string,
    title: string,
    forms: FormSchema[],
    keyTexts: string[]
  ): PageFingerprint {
    const urlPath = extractUrlPath(url);
    const formSignatures = forms.map((f) => {
      const fieldNames = f.fields
        .map((fd) => `${fd.type}:${fd.label}`)
        .sort()
        .join(",");
      return `form[${f.action ?? ""}]:${fieldNames}`;
    });
    const keyElementsHash = hashString(title + "|" + keyTexts.sort().join("|"));
    return { urlPath, formSignatures, keyElementsHash };
  }

  /** 指纹转字符串 key */
  fingerprintKey(fp: PageFingerprint): string {
    return `${fp.urlPath}::${fp.formSignatures.join(";;")}::${fp.keyElementsHash}`;
  }

  /** 分类页面状态 */
  classify(fp: PageFingerprint): PageStateType {
    // 检测 URL 中的错误特征
    if (
      /\/error|\/404|\/500|error\.|notfound/i.test(fp.urlPath) ||
      /error|not found|404|500/i.test(fp.keyElementsHash)
    ) {
      return "error";
    }

    // 检测表单相关
    const hasPassword = fp.formSignatures.some((s) =>
      /password/i.test(s)
    );
    const hasLogin = fp.formSignatures.some((s) =>
      /login|signin|登录/i.test(s)
    );
    const hasRegister = fp.formSignatures.some((s) =>
      /register|signup|注册/i.test(s)
    );
    const hasSubmit = fp.formSignatures.some((s) =>
      /submit|提交|submit/i.test(s)
    );

    if (hasPassword && (hasLogin || fp.urlPath.includes("login"))) {
      return "login";
    }
    if (hasRegister || fp.urlPath.includes("register")) {
      return "register";
    }
    if (fp.formSignatures.length > 0 && hasSubmit) {
      return "form";
    }
    if (fp.formSignatures.length > 0) {
      return "form";
    }

    // 检测是否已登录
    if (
      /logout|signout|退出|account|profile|dashboard/i.test(fp.keyElementsHash) ||
      /dashboard|account|profile|home/i.test(fp.urlPath)
    ) {
      return "logged-in";
    }

    return "content";
  }

  /** 注册或更新状态 */
  registerState(fp: PageFingerprint, step: number): PageStateNode {
    const key = this.fingerprintKey(fp);
    const existing = this.states.find((s) => this.fingerprintKey(s.fingerprint) === key);
    if (existing) {
      existing.visitCount += 1;
      existing.stateType = this.classify(fp); // 重新分类（可能有更准确的信息）
      return existing;
    }
    const stateType = this.classify(fp);
    const node: PageStateNode = {
      fingerprint: fp,
      stateType,
      firstSeenAt: step,
      visitCount: 1,
    };
    this.states.push(node);
    this.knownFingerprints.add(key);
    return node;
  }

  /** 记录状态转移 */
  transition(
    from: PageFingerprint,
    to: PageFingerprint,
    step: number,
    action: string
  ): StateTransition {
    const fromState = this.classify(from);
    const toState = this.classify(to);
    const t: StateTransition = {
      step,
      from,
      to,
      fromState,
      toState,
      action: action as StateTransition["action"],
      timestamp: new Date().toISOString(),
    };
    this.transitions.push(t);

    if (fromState !== toState) {
      console.log(
        `[state-machine] 状态转移 step ${step}: ${fromState} → ${toState}`
      );
    }
    return t;
  }

  /** 判断指纹是否为新状态 */
  isNewState(fp: PageFingerprint): boolean {
    return !this.knownFingerprints.has(this.fingerprintKey(fp));
  }

  /** 获取当前状态 */
  getCurrentState(): PageStateNode | null {
    return this.states.length > 0 ? this.states[this.states.length - 1] : null;
  }

  /** 获取所有已访问状态 */
  getVisitedStates(): PageStateNode[] {
    return [...this.states];
  }

  /** 获取所有转移记录 */
  getTransitions(): StateTransition[] {
    return [...this.transitions];
  }

  /** 获取状态转移摘要（供 LLM prompt 使用） */
  getSummary(): string {
    const uniqueStates = this.states
      .map((s) => s.stateType)
      .filter((v, i, a) => a.indexOf(v) === i);
    const transitionSummary = this.transitions
      .slice(-5)
      .map((t) => `  step${t.step}: ${t.fromState} → ${t.toState} (${t.action})`)
      .join("\n");

    return [
      `已访问状态类型: ${uniqueStates.join(", ") || "none"}`,
      `状态总数: ${this.states.length}`,
      `最近转移:\n${transitionSummary || "  (无)"}`,
    ].join("\n");
  }
}
