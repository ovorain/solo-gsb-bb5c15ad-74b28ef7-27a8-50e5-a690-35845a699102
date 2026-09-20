/**
 * 应用领域类型
 */

/** 事件（时间轴上的一个待定位的点） */
export interface TEvent {
  id: string
  name: string
  note?: string
}

/** 关系方向：A 早于 B，或 A 晚于 B */
export type Relation = 'earlier' | 'later'

/**
 * 一条“事件 A 比事件 B {早|晚} min..max 分钟”的约束。
 * min <= max，单位为分钟（整数）。
 */
export interface Constraint {
  id: string
  aId: string
  bId: string
  relation: Relation
  min: number
  max: number
  enabled: boolean
}

/** 应用持久化状态 */
export interface AppState {
  events: TEvent[]
  constraints: Constraint[]
  /** 锚点事件 id */
  anchorId: string | null
  /** 锚点绝对时间（本地时间，ISO 格式 yyyy-MM-ddTHH:mm） */
  anchorTime: string
  /**
   * 各事件的期望绝对时刻（本地时间，ISO 格式 yyyy-MM-ddTHH:mm），按事件 id 索引。
   * 仅非锚点事件可填写；与项目其余状态一起持久化。
   * 未与锚点连通的事件即使填写也不参与最小偏差求解（排程中标记为“未定时”）。
   */
  expectedTimes: Record<string, string>
}

/** 差分图中的一条有向边 u -> v，权重 w（分钟），表示 t_v - t_u <= w */
export interface DiffEdge {
  u: number
  v: number
  w: number
  /** 产生该边的约束 id */
  constraintId: string
  /** 该边是约束的上界侧还是下界侧 */
  bound: 'upper' | 'lower'
}

export interface AnalysisResult {
  /** 是否存在矛盾（负环） */
  satisfiable: boolean
  /** 命中的一条矛盾环（按沿环行走的顺序） */
  cycle?: CycleInfo
  /** 每个事件的时间窗（仅可满足时计算） */
  windows: Map<number, WindowInfo>
}

export interface CycleInfo {
  /** 环上的节点，按环顺序，首尾不重复 */
  nodes: number[]
  /** 环上的边，edges[i] 从 nodes[i] 指向 nodes[(i+1) % n] */
  edges: DiffEdge[]
  /** 环上权重之和（严格小于 0） */
  totalWeight: number
}

export type WindowStatus = 'anchor' | 'bounded' | 'oneSided' | 'disconnected'

export interface WindowInfo {
  status: WindowStatus
  /** 相对锚点最早偏移（分钟）；单边/不可达时可能为 null（-∞） */
  earliestOffset: number | null
  /** 相对锚点最晚偏移（分钟）；单边/不可达时可能为 null（+∞） */
  latestOffset: number | null
}

/**
 * 边界追溯中的一步：沿一条差分边把边界从 from 事件推进到 to 事件。
 * edge 始终为原始图方向的差分边（u -> v，权 w 表示 t_v - t_u <= w）；
 * 最早边界在反向图上推导，此时行走方向 from -> to 与 edge.u -> edge.v 相反。
 */
export interface BoundTraceStep {
  /** 本步采用的原始差分边（含约束 id 与上/下界侧） */
  edge: DiffEdge
  /** 推导方向上的起点事件下标（从锚点出发） */
  from: number
  /** 推导方向上的终点事件下标 */
  to: number
  /** 走完该步后，to 事件相对锚点的累计偏移（分钟） */
  cumulative: number
}

/**
 * 某事件最早/最晚边界的推导链：从锚点出发的紧约束链。
 * steps 按推导顺序排列；锚点自身为零步证明（steps 为空）。
 */
export interface BoundTrace {
  /** 目标事件下标 */
  eventIdx: number
  /** 追溯的是最早边界还是最晚边界 */
  kind: 'earliest' | 'latest'
  /** 推导出的边界值：相对锚点的偏移（分钟） */
  offset: number
  /** 从锚点出发按推导顺序排列的步骤 */
  steps: BoundTraceStep[]
}

/**
 * 最小修复方案：停用 disableConstraintIds 中的约束后，差分系统恢复可满足。
 */
export interface RepairPlan {
  /** 建议停用的约束 id（按约束录入顺序升序排列） */
  disableConstraintIds: string[]
  /** 停用上述约束后，每个事件相对锚点的时间窗 */
  windows: Map<number, WindowInfo>
}

/** 最小修复搜索结果 */
export interface RepairSearchResult {
  /** 是否找到至少一个可满足修复方案 */
  found: boolean
  /** 并列最优方案，最多 5 个，按需停用约束的录入顺序稳定排序 */
  plans: RepairPlan[]
  /** 已找到的并列最优方案总数（可能大于 plans.length；截断时为下界） */
  totalPlans: number
  /** 每个方案需停用的约束数量（found 为 true 时即已证明的最小停用数） */
  disableCount: number
  /** 是否因达到累计状态数上限而提前停止（结果可能不完备） */
  truncated: boolean
  /** 最小停用数是否已被证明（found 为 true 时恒为 true） */
  optimumProven: boolean
  /** 累计访问的搜索状态数 */
  statesVisited: number
  /** 状态数上限（默认 2000） */
  stateLimit: number
}

/* ===================== 最小偏差排程 ===================== */

/** 排程中单个事件的定位结果 */
export interface ScheduledEvent {
  /** 事件下标 */
  eventIdx: number
  /** 是否已定时：与锚点在（启用约束）无向图上连通且锚点存在 */
  timed: boolean
  /**
   * 实际时刻相对锚点的偏移（分钟，整数）；timed 为 false 时为 null。
   * 由整体可满足性搜索给出的确定性可行解（超级源点 Bellman-Ford 可行位势）。
   */
  actualOffset: number | null
  /** 该事件是否填写了合法期望时刻 */
  hasExpectation: boolean
  /** 期望时刻相对锚点的偏移（分钟，整数）；无合法期望/锚点时间非法时为 null */
  expectedOffset: number | null
  /**
   * 实际相对期望的偏差（分钟，整数）= actualOffset − expectedOffset；
   * 未定时或无期望时为 null。
   */
  deviation: number | null
  /** 该事件是否为期望事件且偏差绝对值恰好达到最大偏差 D（即达到 ±D） */
  hitsBound: boolean
}

/**
 * 最小偏差排程结果。
 *
 * 在约束系统可满足且已设置锚点时，求最小非负整数 D，使全部启用约束
 * 与每个“已定时期望事件”的 |实际 − 期望| ≤ D 同时可满足；
 * 整体作为单个差分约束系统做可满足性搜索（不能逐事件独立夹到现有时间窗）。
 */
export interface ScheduleResult {
  /** 锚点事件下标 */
  anchorIdx: number
  /** 最小非负整数 D（分钟） */
  d: number
  /** 参与求解（已定时且填写了合法期望时刻）的事件下标，按下标升序 */
  targetIdxs: number[]
  /** 已填写期望但仍未与锚点连通、因而不参与求解并标记为未定时的事件下标 */
  disconnectedExpectedIdxs: number[]
  /** 每个事件的定位结果 */
  events: ScheduledEvent[]
  /** 搜索过程中测试的可满足性次数（调试/说明用） */
  feasibilityChecks: number
  /** 是否因 D 达到安全上限而停止（正常数据不会发生） */
  capped: boolean
}
