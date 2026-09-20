import type { Constraint, ScheduleEntry, ScheduleResult, TEvent } from '../types'
import { analyze, buildEdges, feasiblePotentials } from './graph'

const MINUTE_MS = 60_000

/** 钉住期望事件时使用的合成约束 id（仅内部标识，不进入展示） */
const PIN_ID = '__desired_pin__'

/** 解析期望时刻为相对锚点的分钟偏移；无效输入返回 null */
function desiredOffsetMin(anchorISO: string, desiredISO: string): number | null {
  const a = new Date(anchorISO).getTime()
  const t = new Date(desiredISO).getTime()
  if (Number.isNaN(a) || Number.isNaN(t)) return null
  return Math.round((t - a) / MINUTE_MS)
}

/**
 * 最小偏差排程。
 *
 * 前提：约束系统可满足且已设置锚点（不满足时返回 null）。
 * 对每个「已填写有效期望时刻且与锚点连通」的非锚点事件 i，记其期望相对锚点偏移为
 * d_i，求最小非负整数 D，使原差分系统与全部钉住约束
 *
 *     d_i − D ≤ t_i − t_anchor ≤ d_i + D
 *
 * 同时可满足。每个候选 D 的可行性都通过对**整体**差分图做负环检测来判定
 * （整体可满足性搜索），而不是把各事件独立夹到各自的时间窗——后者忽略事件间
 * 耦合（例如 t_Y = t_X + 5 时，X、Y 各自的窗口都可能包含期望值，但二者不能
 * 同时取到），会得出偏小的伪最优。
 *
 * 搜索结构：
 * 1. 上界：原系统的任一可行势 t*（超级源点 Bellman-Ford）即给出一个可行
 *    D_ub = max_i |t*_i − d_i|；
 * 2. 在 [0, D_ub] 上二分最小的可行非负整数 D；
 * 3. 取 D 对应钉住图上的一组可行势作为输出排程（锚点平移到 0）。边集与边顺序
 *    确定时 Bellman-Ford 结果确定，因此输出是确定性的可行排程。
 *    由于 D 最小（D − 1 不可行），任何可行排程的最大偏差都恰好为 D，
 *    故输出排程必然有事件达到 ±D。
 *
 * 与锚点不连通的事件不参与搜索，在结果中标记为 unscheduled（未定时）；
 * 其上填写的期望时刻被忽略（desiredIgnored = true）。
 */
export function computeMinDeviationSchedule(
  events: TEvent[],
  constraints: Constraint[],
  anchorId: string | null,
  anchorTime: string,
  desiredTimes: Record<string, string>,
): ScheduleResult | null {
  const n = events.length
  const anchorIdx = anchorId != null ? events.findIndex((e) => e.id === anchorId) : -1
  if (n === 0 || anchorIdx < 0) return null

  const base = analyze(events, constraints, anchorId)
  if (!base.satisfiable) return null

  const { edges } = buildEdges(events, constraints)
  const idxOf = new Map(events.map((e, i) => [e.id, i]))

  // 期望时刻 → 相对锚点的分钟偏移（锚点自身时间固定，其期望无意义，直接排除）
  const desired = new Map<number, number>()
  for (const [id, iso] of Object.entries(desiredTimes)) {
    const i = idxOf.get(id)
    if (i === undefined || i === anchorIdx || !iso) continue
    const off = desiredOffsetMin(anchorTime, iso)
    if (off !== null) desired.set(i, off)
  }

  const connected = (i: number) => {
    const w = base.windows.get(i)
    return !!w && w.status !== 'disconnected'
  }

  // 参与整体搜索的期望事件：期望有效且与锚点连通（按事件下标升序，保证确定性）
  const targets = [...desired.keys()].filter(connected).sort((a, b) => a - b)
  if (targets.length === 0) return null

  /** 原边 + 给定 D 下全部期望事件的钉住边 */
  const pinnedEdges = (D: number) => {
    const es = edges.slice()
    for (const i of targets) {
      const d = desired.get(i)!
      es.push(
        { u: anchorIdx, v: i, w: d + D, constraintId: PIN_ID, bound: 'upper' as const },
        { u: i, v: anchorIdx, w: D - d, constraintId: PIN_ID, bound: 'lower' as const },
      )
    }
    return es
  }

  // 上界：原系统的可行势 t* 满足全部约束，D_ub = max |t*_i − d_i| 必然可行
  const pot = feasiblePotentials(n, edges)
  if (!pot) return null // 防御：analyze 已判可满足，理论不可达
  let hi = 0
  for (const i of targets) {
    hi = Math.max(hi, Math.abs(pot[i] - pot[anchorIdx] - desired.get(i)!))
  }

  // 二分最小可行非负整数 D；不变式：lo 不可行（−1 为哨兵），hi 可行
  let lo = -1
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (feasiblePotentials(n, pinnedEdges(mid)) !== null) hi = mid
    else lo = mid
  }
  const D = hi

  // 输出排程：钉住图上的一组可行势，锚点平移到 0（确定性）
  const h = feasiblePotentials(n, pinnedEdges(D))!
  const offsetOf = (i: number) => h[i] - h[anchorIdx]

  const entries: ScheduleEntry[] = events.map((_, i): ScheduleEntry => {
    const d = desired.get(i) ?? null
    if (i === anchorIdx) {
      return {
        eventIdx: i,
        status: 'anchor',
        offsetMin: 0,
        desiredOffset: null,
        deviation: null,
        desiredIgnored: false,
      }
    }
    if (!connected(i)) {
      return {
        eventIdx: i,
        status: 'unscheduled',
        offsetMin: null,
        desiredOffset: d,
        deviation: null,
        desiredIgnored: d !== null,
      }
    }
    const off = offsetOf(i)
    return {
      eventIdx: i,
      status: 'scheduled',
      offsetMin: off,
      desiredOffset: d,
      deviation: d !== null ? off - d : null,
      desiredIgnored: false,
    }
  })

  const tightEventIdx: number[] = []
  let maxDeviation = 0
  for (const i of targets) {
    const dev = Math.abs(entries[i].deviation!)
    if (dev > maxDeviation) maxDeviation = dev
    if (Math.abs(dev - D) < 1e-9) tightEventIdx.push(i)
  }

  return { D, entries, tightEventIdx, maxDeviation, desiredCount: targets.length }
}
