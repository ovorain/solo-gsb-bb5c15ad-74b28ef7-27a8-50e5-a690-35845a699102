import type { Constraint, DiffEdge, ScheduleResult, ScheduledEvent, TEvent } from '../types'
import { analyze, buildEdges, feasiblePotentials, findNegativeCycle } from './graph'

/** D 的安全上限：正常复盘规模的分钟数远小于此；达到则停止翻倍并标记 capped */
export const MAX_D = 1_000_000

/** 期望值边在图中的标记（不对应任何真实约束） */
export const EXPECTATION_CONSTRAINT_ID = '__expectation__'

/** 把 yyyy-MM-ddTHH:mm 解析为“分钟时间戳”；非法返回 null */
export function parseLocalMinutes(iso: string): number | null {
  if (!iso) return null
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return null
  // round 到分钟（datetime-local 不含秒，但防御性取整）
  return Math.round(t.getTime() / 60000)
}

/** 锚点时间与某期望绝对时间之差（分钟，整数）：期望 − 锚点 */
export function expectedOffsetMinutes(anchorISO: string, expectedISO: string): number | null {
  const a = parseLocalMinutes(anchorISO)
  const e = parseLocalMinutes(expectedISO)
  if (a === null || e === null) return null
  return e - a
}

/**
 * 为一个期望事件构造 |t_i − (t_anchor + off)| ≤ D 的两条差分边：
 *   t_i − t_anchor ≤ off + D   （anchor → i, off + D，上界侧）
 *   t_anchor − t_i ≤ D − off   （i → anchor, D − off，下界侧）
 * 边 u → v 权 w 表示 t_v − t_u ≤ w。
 */
function expectationEdges(
  anchorIdx: number,
  eventIdx: number,
  offset: number,
  d: number,
): DiffEdge[] {
  return [
    {
      u: anchorIdx,
      v: eventIdx,
      w: offset + d,
      constraintId: EXPECTATION_CONSTRAINT_ID,
      bound: 'upper',
    },
    {
      u: eventIdx,
      v: anchorIdx,
      w: d - offset,
      constraintId: EXPECTATION_CONSTRAINT_ID,
      bound: 'lower',
    },
  ]
}

/**
 * 最小偏差排程。
 *
 * 前提（由调用方在界面层保证；此处再校验一次）：
 * - 存在锚点事件；
 * - 全部启用约束构成的差分系统本身可满足（无负环）。
 * 不满足时返回 null（矛盾状态下不产出/展示任何旧排程）。
 *
 * 求解：对每个“已定时”（与锚点在启用约束无向图上连通）且填写了合法期望时刻的
 * 非锚点事件 i（期望相对锚点偏移 off_i），加入
 *   |t_i − (t_anchor + off_i)| ≤ D  ⇔ 两条差分边（off_i ± D）。
 * 求使“全部启用约束 ∧ 全部期望偏差约束”这一**整体**差分系统可满足的
 * 最小非负整数 D。可行性随 D 单调，先翻倍找上界再二分；
 * 绝不能把各事件独立夹到各自现有时间窗（事件间会经约束互相牵动）。
 *
 * 找到最小 D 后，以超级源点 Bellman-Ford 给出一组确定性可行位势作为
 * 实际时刻；与锚点不连通的事件明确标记为未定时。
 */
export function findMinDeviationSchedule(
  events: TEvent[],
  constraints: Constraint[],
  anchorId: string | null,
  anchorTime: string,
  expectedTimes: Record<string, string>,
): ScheduleResult | null {
  const n = events.length
  const anchorIdx = anchorId != null ? events.findIndex((e) => e.id === anchorId) : -1
  if (n === 0 || anchorIdx < 0) return null

  const { edges: baseEdges } = buildEdges(events, constraints)

  // 前提 1：约束系统本身必须可满足
  if (findNegativeCycle(n, baseEdges)) return null

  // 已定时集合：复用时间窗口径（连通图上反向/正向必然都可达，
  // 但以状态是否为 disconnected 为准最稳妥）。
  const { windows } = analyze(events, constraints, anchorId)

  // 解析每个事件的期望偏移（锚点自身不作为期望事件）
  const expectedOffset = new Map<number, number>()
  const hasExpectationArr = new Array<boolean>(n).fill(false)
  events.forEach((ev, i) => {
    if (i === anchorIdx) return
    const raw = expectedTimes[ev.id]
    if (!raw) return
    const off = expectedOffsetMinutes(anchorTime, raw)
    if (off === null) return
    hasExpectationArr[i] = true
    expectedOffset.set(i, off)
  })

  // 参与整体求解的目标：已定时（与锚点连通）且有合法期望
  const targetIdxs: number[] = []
  const disconnectedExpectedIdxs: number[] = []
  for (let i = 0; i < n; i++) {
    if (i === anchorIdx || !hasExpectationArr[i]) continue
    if (windows.get(i)?.status === 'disconnected') disconnectedExpectedIdxs.push(i)
    else targetIdxs.push(i)
  }

  /** 把目标期望边叠加到给定 D，返回整体边集 */
  const edgesForD = (d: number): DiffEdge[] => {
    if (targetIdxs.length === 0) return baseEdges
    const extra: DiffEdge[] = []
    for (const i of targetIdxs) {
      extra.push(...expectationEdges(anchorIdx, i, expectedOffset.get(i)!, d))
    }
    return baseEdges.concat(extra)
  }

  let feasibilityChecks = 0
  const feasible = (d: number): boolean => {
    feasibilityChecks++
    return !findNegativeCycle(n, edgesForD(d))
  }

  // —— 求最小非负整数 D ——
  let d = 0
  let capped = false
  if (targetIdxs.length > 0 && !feasible(0)) {
    // 可行性关于 D 单调：翻倍找到第一个可行上界 hi（lo=0 不可行）
    let lo = 0
    let hi = 1
    while (hi < MAX_D && !feasible(hi)) hi = Math.min(MAX_D, hi * 2)
    if (hi >= MAX_D && !feasible(MAX_D)) {
      // 偏差需求超过安全上限：正常数据不会发生，无法给出排程
      return null
    }
    capped = hi >= MAX_D
    // 二分最小可行 D（lo 不可行、hi 可行）
    while (lo + 1 < hi) {
      const mid = Math.floor((lo + hi) / 2)
      if (feasible(mid)) hi = mid
      else lo = mid
    }
    d = hi
  }

  // —— 输出确定性可行排程：最小 D 下的一组可行位势 ——
  const finalEdges = edgesForD(d)
  const potentials = feasiblePotentials(n, finalEdges)
  // 翻倍到 MAX_D 仍不可行（理论上正常数据不会发生）：无法给出排程
  if (!potentials) return null

  // 位势是平移无关的可行解；以锚点为基准换算为“相对锚点偏移”
  const anchorPotential = potentials[anchorIdx]

  const scheduled: ScheduledEvent[] = events.map((_, i) => {
    if (i === anchorIdx) {
      return {
        eventIdx: i,
        timed: true,
        actualOffset: 0,
        hasExpectation: false,
        expectedOffset: null,
        deviation: null,
        hitsBound: false,
      }
    }
    const isDisconnected = windows.get(i)?.status === 'disconnected'
    if (isDisconnected) {
      // 未与锚点连通：即使有期望也不参与求解，明确标记为未定时
      return {
        eventIdx: i,
        timed: false,
        actualOffset: null,
        hasExpectation: hasExpectationArr[i],
        expectedOffset: expectedOffset.get(i) ?? null,
        deviation: null,
        hitsBound: false,
      }
    }
    const actualOffset = potentials[i] - anchorPotential
    const off = expectedOffset.get(i) ?? null
    const deviation = off === null ? null : actualOffset - off
    return {
      eventIdx: i,
      timed: true,
      actualOffset,
      hasExpectation: hasExpectationArr[i],
      expectedOffset: off,
      deviation,
      hitsBound: deviation !== null && Math.abs(deviation) === d,
    }
  })

  return {
    anchorIdx,
    d,
    targetIdxs,
    disconnectedExpectedIdxs,
    events: scheduled,
    feasibilityChecks,
    capped,
  }
}
