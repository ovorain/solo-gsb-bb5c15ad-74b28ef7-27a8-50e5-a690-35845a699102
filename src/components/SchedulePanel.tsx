import type { ScheduleResult, TEvent, WindowInfo } from '../types'
import { formatAbsolute, formatOffset } from '../lib/format'

interface Props {
  events: TEvent[]
  anchorId: string | null
  anchorTime: string
  desiredTimes: Record<string, string>
  /** 有效约束系统是否可满足；矛盾时不展示任何旧排程结果 */
  satisfiable: boolean
  anchorExists: boolean
  /** 有效时间窗（用于识别未与锚点连通的事件） */
  windows: Map<number, WindowInfo>
  /** 排程结果；无可参与期望时为 null */
  schedule: ScheduleResult | null
  onDesiredChange: (eventId: string, iso: string | null) => void
}

/** 偏差展示：+5 分钟 / −3 分钟 / 0 分钟 */
function deviationText(d: number): string {
  if (d === 0) return '0 分钟'
  return `${d > 0 ? '+' : '−'}${Math.abs(d)} 分钟`
}

/**
 * 最小偏差排程面板：为非锚点事件填写期望时刻，系统对整体差分系统搜索
 * 最小非负整数偏差 D，使全部约束与每个期望「实际时刻 ∈ 期望 ±D」同时可满足，
 * 并输出一份确定性的可行排程。任何编辑都会触发实时重算；
 * 约束矛盾时不展示任何旧结果。
 */
export default function SchedulePanel({
  events,
  anchorId,
  anchorTime,
  desiredTimes,
  satisfiable,
  anchorExists,
  windows,
  schedule,
  onDesiredChange,
}: Props) {
  const anchorIdx = anchorId != null ? events.findIndex((e) => e.id === anchorId) : -1
  const ready = satisfiable && anchorExists
  const tight = new Set(schedule?.tightEventIdx ?? [])
  const anyDesired = events.some((e) => e.id !== anchorId && !!desiredTimes[e.id])

  return (
    <div className="panel schedule-panel">
      <h3>
        最小偏差排程
        <span className="count">
          {schedule
            ? `最小偏差 D = ${schedule.D} 分钟 · ${schedule.desiredCount} 个期望事件参与整体搜索`
            : '为非锚点事件填写期望时刻后自动计算'}
        </span>
      </h3>

      {events.length === 0 && (
        <div className="empty-hint">添加事件、指定锚点并录入约束后，可使用最小偏差排程。</div>
      )}

      {events.length > 0 && !satisfiable && (
        <div className="schedule-note danger">
          ⛔ 约束系统存在矛盾，最小偏差排程不可用：请先核对证词或按上方修复建议处理。
          矛盾解除前<strong>不展示任何排程结果</strong>（避免误用过期结论）。
        </div>
      )}

      {events.length > 0 && satisfiable && !anchorExists && (
        <div className="schedule-note warn">
          🎯 尚未指定锚点事件：请先在事件列表中点选锚点并设置锚点绝对时间，再填写期望时刻。
        </div>
      )}

      {events.length > 0 && ready && (
        <>
          <div className="desired-title">
            期望时刻（仅非锚点事件；留空则不参与排程；未与锚点连通的事件不参与）
          </div>
          <div className="desired-list">
            {events.map((ev, i) => {
              if (i === anchorIdx) return null
              const disconnected = windows.get(i)?.status === 'disconnected'
              const val = desiredTimes[ev.id] ?? ''
              return (
                <div className="desired-row" key={ev.id}>
                  <span className="name" title={ev.name}>
                    {ev.name}
                  </span>
                  {disconnected && (
                    <span className="badge offlink" title="该事件与锚点没有约束通路，期望时刻不参与排程">
                      未连通
                    </span>
                  )}
                  <input
                    type="datetime-local"
                    value={val}
                    onChange={(e) => onDesiredChange(ev.id, e.target.value || null)}
                    aria-label={`${ev.name} 的期望时刻`}
                  />
                  {val && (
                    <button
                      className="small"
                      onClick={() => onDesiredChange(ev.id, null)}
                      title="清除该期望时刻"
                    >
                      清除
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          {!schedule && (
            <div className="empty-hint">
              {anyDesired
                ? '已填写的期望时刻均属于未与锚点连通的事件，不参与排程；请为可定时事件填写期望时刻。'
                : '还没有期望时刻：填写后系统将对整体差分系统搜索最小偏差 D，并给出一份确定性的可行排程。'}
            </div>
          )}

          {schedule && (
            <>
              <div className="schedule-summary">
                <span>
                  最小偏差 <span className="dval">D = {schedule.D}</span> 分钟
                </span>
                <span className="sep">·</span>
                <span>本排程最大偏差 {schedule.maxDeviation} 分钟</span>
                {schedule.tightEventIdx.length > 0 && (
                  <>
                    <span className="sep">·</span>
                    <span>
                      达到 ±D：{schedule.tightEventIdx.map((i) => `「${events[i].name}」`).join('、')}
                    </span>
                  </>
                )}
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table className="windows">
                  <thead>
                    <tr>
                      <th>事件</th>
                      <th>状态</th>
                      <th className="num">实际时刻</th>
                      <th className="num">相对锚点</th>
                      <th className="num">期望时刻</th>
                      <th className="num">期望偏差</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schedule.entries.map((en) => {
                      const ev = events[en.eventIdx]
                      return (
                        <tr key={ev.id}>
                          <td>
                            {ev.name}
                            {en.status === 'unscheduled' && (
                              <div style={{ color: 'var(--text-muted)', fontSize: 11.5 }}>
                                未与锚点连通{en.desiredIgnored && '，期望时刻未生效'}
                              </div>
                            )}
                          </td>
                          <td>
                            {en.status === 'anchor' && <span className="status-pill anchor">锚点</span>}
                            {en.status === 'scheduled' && (
                              <span className="status-pill bounded">已定时</span>
                            )}
                            {en.status === 'unscheduled' && (
                              <span
                                className="status-pill disconnected"
                                title="与锚点没有任何约束通路，无法定时"
                              >
                                未定时
                              </span>
                            )}
                          </td>
                          <td className="num">
                            {en.offsetMin !== null ? formatAbsolute(anchorTime, en.offsetMin) : '—'}
                          </td>
                          <td className="num">
                            {en.offsetMin !== null ? formatOffset(en.offsetMin) : '—'}
                          </td>
                          <td className="num">
                            {en.desiredOffset !== null
                              ? formatAbsolute(anchorTime, en.desiredOffset)
                              : '—'}
                          </td>
                          <td className="num">
                            {en.deviation !== null ? (
                              <>
                                {deviationText(en.deviation)}
                                {tight.has(en.eventIdx) && (
                                  <span
                                    className="badge tight"
                                    title={`该事件的偏差达到最小偏差 D = ${schedule.D} 分钟`}
                                  >
                                    达到 ±D
                                  </span>
                                )}
                              </>
                            ) : (
                              '—'
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
