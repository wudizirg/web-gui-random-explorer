export type ActionType = "click" | "input" | "select" | "scroll" | "back" | "wait";

export type LlmVisionMode = "always" | "on-navigation";

export interface ExplorerOptions {
  url: string;
  steps: number;
  seed?: string;
  headless?: boolean;
  timeoutMs?: number;
  waitAfterActionMs?: number;
  maxInputsPerPage?: number;
  llmEnabled?: boolean;
  llmModel?: string;
  llmEndpoint?: string;
  llmApiKey?: string;
  llmVision?: LlmVisionMode;
  screenshotDir?: string;
  llmConversation?: boolean;
  /** 新增：启用异常检测与回溯 */
  anomalyDetection?: boolean;
  /** 新增：最大回溯次数，默认 3 */
  maxBacktrack?: number;
  /** 新增：是否保存 DOM 快照 */
  domSnapshot?: boolean;
  /** 新增：DOM 快照输出目录 */
  snapshotDir?: string;
}

export interface ActionLog {
  step: number;
  type: ActionType;
  label: string;
  selector?: string;
  value?: string;
  details?: string;
}

export interface PageContext {
  url: string;
  title: string;
  screenshotPath: string;
  capabilities: string[];
  elementsSummary: string;
  filledInputsSummary?: string;
  clickableCount: number;
  inputCount: number;
}

export interface LlmAction {
  action: ActionType;
  /** Prefer this over selector when present; matches data-gui-explorer-id on the page. */
  targetIndex?: number;
  selector?: string;
  value?: string;
  amount?: number;
  reason?: string;
}

// ═══════════════════════════════════════════
// 方向一：页面状态抽象类型
// ═══════════════════════════════════════════

/** 页面状态分类 */
export type PageStateType =
  | "initial"
  | "login"
  | "register"
  | "form"
  | "content"
  | "error"
  | "logged-in"
  | "form-submitted"
  | "unknown";

/** 页面指纹：用于唯一标识一个页面状态 */
export interface PageFingerprint {
  /** URL 路径部分（去掉 query） */
  urlPath: string;
  /** 页面内所有 form 的签名（action + input name 集合） */
  formSignatures: string[];
  /** 关键元素的 hash（标题 + 主要按钮文本） */
  keyElementsHash: string;
}

/** 状态转移记录 */
export interface StateTransition {
  step: number;
  from: PageFingerprint;
  to: PageFingerprint;
  fromState: PageStateType;
  toState: PageStateType;
  action: ActionType;
  timestamp: string;
}

/** 页面状态节点 */
export interface PageStateNode {
  fingerprint: PageFingerprint;
  stateType: PageStateType;
  firstSeenAt: number; // step
  visitCount: number;
}

// ═══════════════════════════════════════════
// 方向一：表单结构感知类型
// ═══════════════════════════════════════════

/** 单个表单字段 */
export interface FormField {
  /** 语义名称（label 文本 或 name 属性） */
  label: string;
  /** 输入类型：text / password / email / tel / number / checkbox / select / textarea */
  type: string;
  /** 是否必填 */
  required: boolean;
  /** 稳定的 CSS 选择器 */
  selector: string;
  /** 是否已填写 */
  filled: boolean;
  /** placeholder 文本 */
  placeholder?: string;
  /** 所属表单的 id 或选择器 */
  formSelector?: string;
}

/** 表单结构 */
export interface FormSchema {
  /** 表单选择器 */
  formSelector: string;
  /** 表单 action 属性 */
  action?: string;
  /** 表单内的字段列表（按 DOM 顺序） */
  fields: FormField[];
  /** 提交按钮选择器 */
  submitSelector?: string;
  /** 表单在页面中的顺序索引 */
  index: number;
}

// ═══════════════════════════════════════════
// 方向三：DOM 快照类型
// ═══════════════════════════════════════════

/** 简化的 DOM 元素节点 */
export interface DomElementNode {
  tag: string;
  attributes: Record<string, string>;
  text: string; // 直接文本内容，截断到 200 字符
  children: DomElementNode[];
  selector: string;
}

/** DOM 快照 */
export interface DomSnapshotRecord {
  step: number;
  url: string;
  title: string;
  timestamp: string;
  /** 简化的 body DOM 树 */
  bodyTree: DomElementNode;
  /** 交互元素摘要（与 PageContext.elementsSummary 一致） */
  elementsSummary: string;
  /** 表单结构（如有） */
  forms: FormSchema[];
}

// ═══════════════════════════════════════════
// 方向三：异常检测类型
// ═══════════════════════════════════════════

/** 异常类型 */
export type AnomalyType =
  | "js-error"       // 未捕获的 JS 异常
  | "console-error"  // console.error 调用
  | "page-crash"     // 页面崩溃
  | "http-error"     // 4xx / 5xx 状态
  | "blank-page"     // 空白页面
  | "navigation-loss" // 意外导航离开
  | "timeout";       // 操作超时

/** 异常记录 */
export interface AnomalyRecord {
  step: number;
  type: AnomalyType;
  message: string;
  url: string;
  timestamp: string;
  screenshotPath?: string;
  /** 额外上下文 */
  details?: string;
}

// ═══════════════════════════════════════════
// 方向三：回溯类型
// ═══════════════════════════════════════════

/** 回溯快照：保存一个已知良好的状态 */
export interface BacktrackSnapshot {
  step: number;
  url: string;
  fingerprint: PageFingerprint;
  screenshotPath: string;
  /** 对应的 DOM 快照文件路径 */
  domSnapshotPath?: string;
}

/** 回溯结果 */
export interface BacktrackResult {
  recovered: boolean;
  newStep: number;
  attempts: number;
  message: string;
}

// ═══════════════════════════════════════════
// 方向二：LLM 增强策略类型
// ═══════════════════════════════════════════

/** 多步规划中的单步 */
export interface PlannedStep {
  action: ActionType;
  selector?: string;
  value?: string;
  amount?: number;
  reason: string;
  /** 预期到达的页面状态 */
  expectedState?: PageStateType;
}

/** LLM 多步规划结果 */
export interface StrategyPlan {
  steps: PlannedStep[];
  goal: string;
  /** 规划时的页面 URL */
  contextUrl: string;
}

/** 增强后的 LLM 上下文（构建 prompt 用） */
export interface LlmEnhancedContext {
  pageContext: PageContext;
  currentState: PageStateNode | null;
  stateHistory: StateTransition[];
  formSchemas: FormSchema[];
  fillProgress: string; // e.g. "1/3 fields filled"
  visitedStates: PageStateType[];
  anomalyWarnings: string[];
}
