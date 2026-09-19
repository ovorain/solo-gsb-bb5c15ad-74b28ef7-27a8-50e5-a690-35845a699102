import { analyze, buildEdges, constraintToEdges, traceBound } from '../src/lib/graph'
import { DEFAULT_STATE_LIMIT, findMinimalRepairs, MAX_PLANS } from '../src/lib/repair'
import { buildConsistentSample, buildContradictionSample } from '../src/lib/samples'
import type { Constraint, TEvent } from '../src/types'

let passed = 0
let failed = 0

function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++
  } else {
    failed++
    console.error('FAIL:', msg)
  }
}

function approxEq(a: number | null, b: number | null) {
  if (a === null || b === null) return a === b
  return a === b
}

// ---- 单条约束的边转换 ----
{
  const c: Constraint = {
    id: 'c1', aId: 'A', bId: 'B', relation: 'earlier', min: 3, max: 8, enabled: true,
  }
  const idx = new Map([['A', 0], ['B', 1]])
  const es = constraintToEdges(c, (id) => idx.get(id)!)
  // earlier: A->B +8 (t_B - t_A <= 8), B->A -3 (t_A - t_B <= -3)
  assert(es.some((e) => e.u === 0 && e.v === 1 && e.w === 8), 'earlier 上界边 A->B +8')
  assert(es.some((e) => e.u === 1 && e.v === 0 && e.w === -3), 'earlier 下界边 B->A -3')

  const c2: Constraint = {
    id: 'c2', aId: 'A', bId: 'B', relation: 'later', min: 3, max: 8, enabled: true,
  }
  const es2 = constraintToEdges(c2, (id) => idx.get(id)!)
  assert(es2.some((e) => e.u === 1 && e.v === 0 && e.w === 8), 'later 上界边 B->A +8')
  assert(es2.some((e) => e.u === 0 && e.v === 1 && e.w === -3), 'later 下界边 A->B -3')
}

// ---- 禁用约束不产生边 ----
{
  const state = buildConsistentSample()
  const all = buildEdges(state.events, state.constraints).edges.length
  const disabled = state.constraints.map((c) => ({ ...c, enabled: false }))
  assert(buildEdges(state.events, disabled).edges.length === 0, '全部停用时边集为空')
  assert(all === state.constraints.length * 2, '每条约束产生 2 条边')
}

// ---- 可满足示例的窗口 ----
{
  const s = buildConsistentSample()
  const r = analyze(s.events, s.constraints, s.anchorId)
  assert(r.satisfiable, '可满足示例判定为可满足')
  assert(!r.cycle, '可满足示例无矛盾环')
  const byName = new Map(s.events.map((e, i) => [e.name, i]))
  const w = (name: string) => r.windows.get(byName.get(name)!)!

  assert(approxEq(w('值班工程师介入').earliestOffset, 2), '介入最早 +2')
  assert(approxEq(w('值班工程师介入').latestOffset, 5), '介入最晚 +5')
  assert(approxEq(w('定位到故障节点').earliestOffset, 5), '定位最早 +5')
  assert(approxEq(w('定位到故障节点').latestOffset, 15), '定位最晚 +15')
  assert(approxEq(w('完成流量切换').earliestOffset, 6), '切换最早 +6')
  assert(approxEq(w('完成流量切换').latestOffset, 19), '切换最晚 +19（受恢复反推约束）')
  assert(approxEq(w('服务恢复').earliestOffset, 10), '恢复最早 +10（受"定位早于恢复5~15"收紧）')
  assert(approxEq(w('服务恢复').latestOffset, 20), '恢复最晚 +20（整体约束）')
  assert(approxEq(w('复盘会议').earliestOffset, 70), '复盘最早 +70')
  assert(approxEq(w('复盘会议').latestOffset, 200), '复盘最晚 +200')
  assert(w('媒体报道').status === 'disconnected', '媒体报道未连通 -> 无法定时')
  assert(w('值班告警触发').status === 'anchor', '告警为锚点')
}

// ---- 矛盾示例：负环提取 ----
{
  const s = buildContradictionSample()
  const r = analyze(s.events, s.constraints, s.anchorId)
  assert(!r.satisfiable, '矛盾示例判定为不可满足')
  assert(!!r.cycle, '提取出矛盾环')
  if (r.cycle) {
    assert(r.cycle.totalWeight === -25, '环权重之和 = -25')
    // 环必须覆盖 A、B、C（不含 D）
    const names = r.cycle.nodes.map((i) => s.events[i].name[0]).sort()
    assert(JSON.stringify(names) === JSON.stringify(['A', 'B', 'C']), '环为 A-B-C')
    // 校验 edges[i] 从 nodes[i] 指向 nodes[(i+1)%n]
    const n = r.cycle.nodes.length
    let aligned = true
    for (let i = 0; i < n; i++) {
      const e = r.cycle.edges[i]
      if (e.u !== r.cycle.nodes[i] || e.v !== r.cycle.nodes[(i + 1) % n]) aligned = false
    }
    assert(aligned, '环边与环节点严格对齐 edges[i]: nodes[i] -> nodes[i+1]')
    // 环上的每条边权重确实来自对应约束
    const sum = r.cycle.edges.reduce((a, e) => a + e.w, 0)
    assert(sum === r.cycle.totalWeight, '环权重求和一致')
  }
}

// ---- 精确间隔约束（min == max）：窗口退化为点 ----
{
  const s = buildConsistentSample()
  s.constraints = s.constraints.map((c) =>
    c.aId === s.events[1].id ? { ...c, min: 4, max: 4 } : c,
  )
  const r = analyze(s.events, s.constraints, s.anchorId)
  const w = r.windows.get(1)!
  assert(r.satisfiable, '改精确间隔后仍可满足')
  assert(w.earliestOffset === 4 && w.latestOffset === 4, '介入窗口退化为 +4 单点')
}

// ---- 空系统 / 无锚点 ----
{
  const r0 = analyze([], [], null)
  assert(r0.satisfiable, '空系统可满足')
  const s = buildConsistentSample()
  const r1 = analyze(s.events, s.constraints, null)
  assert(r1.satisfiable, '无锚点时系统仍判可满足')
  assert([...r1.windows.values()].every((w) => w.status === 'disconnected'), '无锚点时全部无法定时')
}

// ---- 经典矛盾：A 早于 B 10 分钟，又晚于 B 5 分钟（两点环） ----
{
  const ev = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ]
  const cs: Constraint[] = [
    { id: 'x', aId: 'a', bId: 'b', relation: 'earlier', min: 10, max: 20, enabled: true },
    { id: 'y', aId: 'a', bId: 'b', relation: 'later', min: 5, max: 8, enabled: true },
  ]
  const r = analyze(ev, cs, 'a')
  assert(!r.satisfiable, '双向时间冲突判为矛盾')
  // t_B - t_A <= 20 且 t_B - t_A <= -5（A later B min5 => B->A +8, A->B -5）
  // 负环 A->B -5, B->A +8? = +3 不为负；另一环 A->B +20, B->A -8 = +12。
  // 实际矛盾: A->B -5 与 B->A -8？A later B 5..8: B->A +8(上界), A->B -5(下界)
  // A earlier B 10..20: A->B +20, B->A -10
  // 环 A->B(-5) B->A(-10) = -15 <0 ✓
  assert(r.cycle !== undefined && r.cycle.totalWeight < 0, '两点负环权重为负')
}

// ---- 最小修复：矛盾示例最少停用 1 条，3 个并列方案 ----
{
  const s = buildContradictionSample()
  const r = findMinimalRepairs(s.events, s.constraints, s.anchorId)
  assert(r.found, '矛盾示例找到修复方案')
  assert(r.disableCount === 1, '矛盾示例最少停用 1 条')
  assert(r.optimumProven && !r.truncated, '最优性已证明且未截断')
  assert(r.totalPlans === 3, `3 个并列最优方案（实际 ${r.totalPlans}）`)
  assert(r.plans.length === 3, '展示全部 3 个方案（≤5）')

  // 每个方案停用 1 条环上约束（前 3 条构成负环；第 4 条是无关正常约束）
  const ringIds = s.constraints.slice(0, 3).map((c) => c.id)
  const unrelatedId = s.constraints[3].id
  for (const plan of r.plans) {
    assert(plan.disableConstraintIds.length === 1, '每个方案停用恰好 1 条')
    assert(ringIds.includes(plan.disableConstraintIds[0]), '停用的是矛盾环上的约束')
    assert(!plan.disableConstraintIds.includes(unrelatedId), '不会建议停用无关约束')
  }

  // 方案按约束录入顺序稳定排序
  const orders = r.plans.map((p) => s.constraints.findIndex((c) => c.id === p.disableConstraintIds[0]))
  assert(JSON.stringify(orders) === JSON.stringify([0, 1, 2]), '方案按录入顺序排序')

  // 每个方案修复后系统确实可满足，且时间窗可计算
  for (const plan of r.plans) {
    const off = new Set(plan.disableConstraintIds)
    const sim = s.constraints.map((c) => (off.has(c.id) ? { ...c, enabled: false } : c))
    const ar = analyze(s.events, sim, s.anchorId)
    assert(ar.satisfiable, '按方案停用后系统可满足')
    assert(plan.windows.get(0)?.status === 'anchor', '方案时间窗：锚点正确')
  }
}

// ---- 最小修复：两个互不相交的负环需各停 1 条（最少 2 条，9 个并列方案）----
{
  const events: TEvent[] = [
    { id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' },
    { id: 'd', name: 'D' }, { id: 'e', name: 'E' }, { id: 'f', name: 'F' },
  ]
  const cs: Constraint[] = [
    // 环 1：A-B-C
    { id: 'c1', aId: 'b', bId: 'a', relation: 'later', min: 10, max: 20, enabled: true },
    { id: 'c2', aId: 'c', bId: 'b', relation: 'later', min: 5, max: 10, enabled: true },
    { id: 'c3', aId: 'a', bId: 'c', relation: 'later', min: 10, max: 30, enabled: true },
    // 环 2：D-E-F
    { id: 'c4', aId: 'e', bId: 'd', relation: 'later', min: 10, max: 20, enabled: true },
    { id: 'c5', aId: 'f', bId: 'e', relation: 'later', min: 5, max: 10, enabled: true },
    { id: 'c6', aId: 'd', bId: 'f', relation: 'later', min: 10, max: 30, enabled: true },
  ]
  assert(!analyze(events, cs, 'a').satisfiable, '双环系统存在矛盾')
  const r = findMinimalRepairs(events, cs, 'a')
  assert(r.found && r.disableCount === 2, '双环最少停用 2 条')
  assert(r.totalPlans === 9, `9 个并列方案（3×3，实际 ${r.totalPlans}）`)
  assert(r.plans.length === MAX_PLANS, '最多展示 5 个')
  assert(!r.truncated, '9 个状态的搜索远未达上限，不截断')

  // 每个方案必须两环各命中一条
  for (const plan of r.plans) {
    const idx = plan.disableConstraintIds.map((id) => cs.findIndex((c) => c.id === id))
    assert(idx.length === 2, '方案停用 2 条')
    assert(idx[0] < 3 && idx[1] >= 3, '两环各停用 1 条')
  }
  // 展示的是字典序最小的 5 个：[0,3],[0,4],[0,5],[1,3],[1,4]
  const firstFive = r.plans.map((p) =>
    p.disableConstraintIds.map((id) => cs.findIndex((c) => c.id === id)),
  )
  assert(
    JSON.stringify(firstFive) === JSON.stringify([[0, 3], [0, 4], [0, 5], [1, 3], [1, 4]]),
    '截断展示录入顺序最靠前的 5 个',
  )
}

// ---- 最小修复：两环共用一条约束时，停用该共用约束为唯一最优 ----
{
  const events: TEvent[] = [
    { id: 'a', name: 'A' }, { id: 'b', name: 'B' },
    { id: 'c', name: 'C' }, { id: 'd', name: 'D' },
  ]
  const cs: Constraint[] = [
    { id: 'g', aId: 'a', bId: 'b', relation: 'earlier', min: 30, max: 40, enabled: true }, // 共用边
    { id: 'x', aId: 'c', bId: 'a', relation: 'later', min: 0, max: 10, enabled: true },
    { id: 'y', aId: 'b', bId: 'c', relation: 'later', min: 0, max: 10, enabled: true },
    { id: 'p', aId: 'd', bId: 'a', relation: 'later', min: 0, max: 10, enabled: true },
    { id: 'q', aId: 'b', bId: 'd', relation: 'later', min: 0, max: 10, enabled: true },
  ]
  assert(!analyze(events, cs, 'a').satisfiable, '双环（共用边）存在矛盾')
  const r = findMinimalRepairs(events, cs, 'a')
  assert(r.found && r.disableCount === 1, '共用约束使最少停用数为 1')
  assert(r.totalPlans === 1 && r.plans.length === 1, '唯一最优方案')
  assert(r.plans[0].disableConstraintIds[0] === 'g', '唯一方案即停用共用约束')
  // 停用共用约束后 A/B 仍有窗口：B 受 0..10 链路约束相对 A
  const wb = r.plans[0].windows.get(1)!
  assert(wb.status === 'bounded', '修复后 B 仍可定时')
}

// ---- 最小修复：状态数上限触发，明确标记可能不完备 ----
{
  const s = buildContradictionSample()
  // stateLimit = 1：只分析根状态（未分支）即达上限，找不到方案
  const r0 = findMinimalRepairs(s.events, s.constraints, s.anchorId, { stateLimit: 1 })
  assert(!r0.found, '上限 1（仅根状态）时未找到方案')
  assert(r0.truncated && !r0.optimumProven, '标记截断且最优性未证明')
  assert(r0.stateLimit === 1 && r0.statesVisited === 1, '回传上限与已访问状态数')

  // stateLimit = 3：根 + 2 个一层状态；三个环约束各停 1 条都可行，
  // 第 3 个并列方案未探索到 -> 找到最优但列表可能不完备
  const r1 = findMinimalRepairs(s.events, s.constraints, s.anchorId, { stateLimit: 3 })
  assert(r1.found && r1.disableCount === 1, '上限 3 时在第 1 层找到最优')
  assert(r1.truncated, '同层未探索完：标记截断（结果可能不完备）')
  assert(r1.plans.length === 2, '只展示已探索到的 2 个并列方案')

  // 双环系统：根 1 + 一层 3 个状态均不可行；上限 4 时第 2 层一个都未分析 -> 未找到且截断
  const events: TEvent[] = [
    { id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' },
    { id: 'd', name: 'D' }, { id: 'e', name: 'E' }, { id: 'f', name: 'F' },
  ]
  const cs: Constraint[] = [
    { id: 'c1', aId: 'b', bId: 'a', relation: 'later', min: 10, max: 20, enabled: true },
    { id: 'c2', aId: 'c', bId: 'b', relation: 'later', min: 5, max: 10, enabled: true },
    { id: 'c3', aId: 'a', bId: 'c', relation: 'later', min: 10, max: 30, enabled: true },
    { id: 'c4', aId: 'e', bId: 'd', relation: 'later', min: 10, max: 20, enabled: true },
    { id: 'c5', aId: 'f', bId: 'e', relation: 'later', min: 5, max: 10, enabled: true },
    { id: 'c6', aId: 'd', bId: 'f', relation: 'later', min: 10, max: 30, enabled: true },
  ]
  const r2 = findMinimalRepairs(events, cs, 'a', { stateLimit: 4 })
  assert(!r2.found && r2.truncated && !r2.optimumProven, '双环在上限 4 时截断且未找到方案')

  // 上限 5：根 + 3 个一层 + 1 个二层可行状态 -> 找到 1 个最优但截断
  const r3 = findMinimalRepairs(events, cs, 'a', { stateLimit: 5 })
  assert(r3.found && r3.disableCount === 2 && r3.truncated, '上限 5 时找到二层最优但截断')
  assert(r3.totalPlans === 1 && r3.optimumProven, '最少停用数 2 仍被证明，并列方案不全')
}

// ---- 最小修复：常量默认值 ----
{
  assert(DEFAULT_STATE_LIMIT === 2000, '默认搜索上限为 2000 个状态')
  assert(MAX_PLANS === 5, '并列方案最多展示 5 个')
}

// ---- 最小修复：可满足系统无需修复 ----
{
  const s = buildConsistentSample()
  const r = findMinimalRepairs(s.events, s.constraints, s.anchorId)
  assert(r.found && r.plans.length === 0 && r.disableCount === 0, '可满足系统返回空方案、停用数 0')
  assert(!r.truncated && r.optimumProven, '可满足系统不截断')
}

// ---- 最小修复：已停用 / 引用缺失事件的约束不进入候选 ----
{
  const s = buildContradictionSample()
  const disabled = s.constraints.map((c, i) =>
    i === 0 ? { ...c, enabled: false } : c,
  )
  // 停用环上第一条后系统本应恢复，这里再验证修复搜索候选不含已停用约束
  const stillConflict = analyze(s.events, disabled, s.anchorId)
  // c1 是 A<-B 约束；停用它后环被打断
  assert(stillConflict.satisfiable, '手动停用环上一条后矛盾消除（与修复建议等价）')
  const r = findMinimalRepairs(s.events, disabled, s.anchorId)
  assert(r.found && r.disableCount === 0 && r.plans.length === 0, '已无可修复矛盾')
}

// ---- 边界追溯：可满足示例的最晚边界（正向图紧约束链）----
{
  const s = buildConsistentSample()
  const byName = new Map(s.events.map((e, i) => [e.name, i]))
  const anchorIdx = byName.get('值班告警触发')!

  // 介入最晚 +5：单步链，采用「介入 晚于 告警 2~5」的上界侧（告警 -> 介入, +5）
  const t1 = traceBound(s.events, s.constraints, s.anchorId, byName.get('值班工程师介入')!, 'latest')!
  assert(t1 !== null && t1.offset === 5, '追溯：介入最晚偏移 +5')
  assert(t1.steps.length === 1, '追溯：介入最晚为单步链')
  assert(t1.steps[0].edge.bound === 'upper' && t1.steps[0].edge.w === 5, '追溯：采用上界侧 +5')
  assert(t1.steps[0].from === anchorIdx && t1.steps[0].to === byName.get('值班工程师介入')!, '追溯：链从锚点指向目标')
  assert(t1.steps[0].cumulative === 5, '追溯：累计偏移 +5')

  // 恢复最晚 +20：唯一直达上界边（告警 -> 恢复, +20）
  const t2 = traceBound(s.events, s.constraints, s.anchorId, byName.get('服务恢复')!, 'latest')!
  assert(t2.offset === 20 && t2.steps.length === 1, '追溯：恢复最晚 +20 为单步直达')
  assert(t2.steps[0].edge.w === 20 && t2.steps[0].cumulative === 20, '追溯：恢复最晚累计 +20')
}

// ---- 边界追溯：最早边界正确还原反向图路径 ----
{
  const s = buildConsistentSample()
  const byName = new Map(s.events.map((e, i) => [e.name, i]))
  const anchorIdx = byName.get('值班告警触发')!
  const onCall = byName.get('值班工程师介入')!
  const recovered = byName.get('服务恢复')!

  // 介入最早 +2：反向图上 告警 -> 介入 走「介入 晚于 告警 2~5」下界侧的反向边
  const t1 = traceBound(s.events, s.constraints, s.anchorId, onCall, 'earliest')!
  assert(t1.offset === 2, '追溯：介入最早偏移 +2')
  assert(t1.steps.length === 1, '追溯：介入最早为单步链')
  const st1 = t1.steps[0]
  assert(st1.edge.bound === 'lower' && st1.edge.w === -2, '追溯：采用下界侧（权 −2）')
  // 原始边方向为 介入 -> 告警（t_告警 − t_介入 ≤ −2），行走方向相反
  assert(st1.edge.u === onCall && st1.edge.v === anchorIdx, '追溯：最早边界还原为原始边方向')
  assert(st1.from === anchorIdx && st1.to === onCall, '追溯：行走方向从锚点出发')
  assert(st1.cumulative === 2, '追溯：最早累计偏移 +2')

  // 恢复最早 +10：反向链 告警 -> 介入 -> 定位 -> 恢复（−2, −3, −5），累计 2, 5, 10
  const t2 = traceBound(s.events, s.constraints, s.anchorId, recovered, 'earliest')!
  assert(t2.offset === 10, '追溯：恢复最早偏移 +10')
  assert(t2.steps.length === 3, '追溯：恢复最早为 3 步链')
  assert(t2.steps[0].from === anchorIdx, '追溯：链起点为锚点')
  assert(t2.steps[2].to === recovered, '追溯：链终点为目标事件')
  for (let i = 1; i < t2.steps.length; i++) {
    assert(t2.steps[i].from === t2.steps[i - 1].to, `追溯：第 ${i + 1} 步与上一步首尾相接`)
  }
  assert(
    JSON.stringify(t2.steps.map((s) => s.cumulative)) === JSON.stringify([2, 5, 10]),
    '追溯：累计偏移依次为 2, 5, 10',
  )
  assert(
    t2.steps.every((s) => s.edge.bound === 'lower') &&
      JSON.stringify(t2.steps.map((s) => s.edge.w)) === JSON.stringify([-2, -3, -5]),
    '追溯：各步均为下界侧，权重 −2/−3/−5',
  )
  // 每步的 edge 必须是原始图中的真实边（u/v 未被反向图污染）
  const origEdges = buildEdges(s.events, s.constraints).edges
  for (const st of t2.steps) {
    assert(
      origEdges.some(
        (e) =>
          e.u === st.edge.u &&
          e.v === st.edge.v &&
          e.w === st.edge.w &&
          e.constraintId === st.edge.constraintId &&
          e.bound === st.edge.bound,
      ),
      '追溯：最早链上的边均来自原始图（反向路径已正确还原）',
    )
  }
}

// ---- 边界追溯：全部事件的追溯值与时间窗一致（性质校验）----
{
  const s = buildConsistentSample()
  const r = analyze(s.events, s.constraints, s.anchorId)
  const anchorIdx = s.events.findIndex((e) => e.id === s.anchorId)!
  for (let i = 0; i < s.events.length; i++) {
    const w = r.windows.get(i)!
    for (const kind of ['earliest', 'latest'] as const) {
      const t = traceBound(s.events, s.constraints, s.anchorId, i, kind)
      const offset = kind === 'earliest' ? w.earliestOffset : w.latestOffset
      if (offset === null) {
        assert(t === null, `追溯：${s.events[i].name} ${kind} 无界时返回 null`)
        continue
      }
      assert(t !== null && t.offset === offset, `追溯：${s.events[i].name} ${kind} 偏移与时间窗一致`)
      if (!t) continue
      if (i === anchorIdx) {
        assert(t.steps.length === 0 && t.offset === 0, '追溯：锚点为零步证明')
        continue
      }
      // 链首尾正确、步步相接、累计收敛到边界值、权重和一致
      assert(t.steps[0].from === anchorIdx, `追溯：${s.events[i].name} ${kind} 链起于锚点`)
      assert(t.steps[t.steps.length - 1].to === i, `追溯：${s.events[i].name} ${kind} 链终于目标`)
      let contiguous = true
      for (let k = 1; k < t.steps.length; k++) {
        if (t.steps[k].from !== t.steps[k - 1].to) contiguous = false
      }
      assert(contiguous, `追溯：${s.events[i].name} ${kind} 链步步相接`)
      const sum = t.steps.reduce((a, st) => a + st.edge.w, 0)
      assert(
        kind === 'latest' ? sum === t.offset : sum === -t.offset,
        `追溯：${s.events[i].name} ${kind} 权重和与边界一致`,
      )
      assert(
        t.steps[t.steps.length - 1].cumulative === t.offset,
        `追溯：${s.events[i].name} ${kind} 末步累计即边界值`,
      )
    }
  }
}

// ---- 边界追溯：锚点零步 / 无界与无锚点返回 null / 停用约束后重算 ----
{
  const s = buildConsistentSample()
  const byName = new Map(s.events.map((e, i) => [e.name, i]))
  const anchorIdx = byName.get('值班告警触发')!

  const ta = traceBound(s.events, s.constraints, s.anchorId, anchorIdx, 'earliest')!
  assert(ta.steps.length === 0 && ta.offset === 0, '追溯：锚点最早为零步证明')
  const tb = traceBound(s.events, s.constraints, s.anchorId, anchorIdx, 'latest')!
  assert(tb.steps.length === 0 && tb.offset === 0, '追溯：锚点最晚为零步证明')

  // 无法定时（媒体报道，与锚点无通路）：两侧均不可追溯
  const press = byName.get('媒体报道')!
  assert(traceBound(s.events, s.constraints, s.anchorId, press, 'earliest') === null, '追溯：无法定时事件最早返回 null')
  assert(traceBound(s.events, s.constraints, s.anchorId, press, 'latest') === null, '追溯：无法定时事件最晚返回 null')

  // 无锚点 / 非法下标
  assert(traceBound(s.events, s.constraints, null, anchorIdx, 'latest') === null, '追溯：无锚点返回 null')
  assert(traceBound(s.events, s.constraints, s.anchorId, 999, 'latest') === null, '追溯：非法事件下标返回 null')

  // 模拟修复预览：停用「恢复 晚于 告警 8~20」后，恢复最晚边界改走 4 步链（+25）
  const recovered = byName.get('服务恢复')!
  const overall = s.constraints.find((c) => c.min === 8 && c.max === 20)!
  const previewed = s.constraints.map((c) => (c.id === overall.id ? { ...c, enabled: false } : c))
  const t = traceBound(s.events, previewed, s.anchorId, recovered, 'latest')!
  assert(t.offset === 25 && t.steps.length === 4, '追溯：停用整体约束后最晚边界按有效约束重算为 +25（4 步）')
  assert(
    JSON.stringify(t.steps.map((s2) => s2.cumulative)) === JSON.stringify([5, 15, 21, 25]),
    '追溯：重算链累计偏移 5/15/21/25',
  )
  assert(!t.steps.some((s2) => s2.edge.constraintId === overall.id), '追溯：重算链不含已停用约束')
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)