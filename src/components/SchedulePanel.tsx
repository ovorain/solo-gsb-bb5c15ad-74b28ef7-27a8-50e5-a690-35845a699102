import type { ScheduleResult, TEvent } from '../types'
import { formatAbsolute, formatSignedMin, describeDeviation } from '../lib/format'

interface Props {
  events: TEvent[]
  schedule: ScheduleResult
  anchorTime: string
  /** 当前持久化的期望绝对时刻（事件 id -> yyyy-MM-ddTHH:mm） */
  expectedTimes: Record<string, string>
  /** 编辑某事件期望时刻（实时重算并持久化） */
  onExpectedChange: (eventId: string, value: string) => void
}

/**
 * 最小偏差排程面板：
 * - 为一个或多个非锚点事件填写期望绝对时刻；
 * - 展示整体可满足性搜索求得的最小最大偏差 D，以及一份确定性的可行排程
 *   （每个已定时事件的实际时刻、相对期望偏差、达到 ±D 的事件）；
 * - 未与锚点连通的事件明确标为“未定时”，其期望不参与求解。
 */
export default function SchedulePanel({
  events,
  schedule,
  anchorTime,
  expectedTimes,
  onExpectedChange,
}: Props) {
  const targetCount = schedule.targetIdxs.length
  const hitCount = schedule.events.filter((s) => s.hitsBound).length
  const disconnectedCount = schedule.disconnectedExpectedIdxs.length

  return (
    <div className="panel schedule-panel">
      <h3>
        最小偏差排程
        <span className="count">
          求最小非负整数 D：全部启用约束与每个期望事件的“实际时刻在期望值 ±D 分钟内”同时可满足
        </span>
      </h3>

      <div className="schedule-summary">
        {targetCount === 0 ? (
          <>
            尚未为任何<strong>已定时</strong>事件填写期望时刻。在下表为一个或多个非锚点事件填写期望绝对时刻后，
            系统会把<strong>全部约束与全部期望作为一个整体差分系统</strong>做可满足性搜索，
            给出最小最大偏差 D 与一份确定性可行排程（不是把各事件独立夹到现有时间窗）。
          </>
        ) : (
          <>
            {schedule.targetIdxs.length} 个期望事件参与整体求解 ·
            最小最大偏差 <code className="d-badge">D = {schedule.d} 分钟</code> ·
            实际排程中 <strong>{hitCount}</strong> 个事件达到 ±D
            （偏差{' '}
            {schedule.events
              .filter((s) => s.hitsBound)
              .map((s) => `${events[s.eventIdx]?.name} ${formatSignedMin(s.deviation)}`)
              .join('、')}
            ）
            {schedule.capped && <span className="schedule-warn"> · 已达到偏差安全上限</span>}
          </>
        )}
        {disconnectedCount > 0 && (
          <div className="schedule-warn">
            另有 {disconnectedCount} 个已填期望的事件仍未与锚点连通，
            不参与求解并标记为“未定时”：
            {schedule.disconnectedExpectedIdxs.map((i) => events[i]?.name).join('、')}
          </div>
        )}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table className="windows schedule-table">
          <thead>
            <tr>
              <th>事件</th>
              <th>定时状态</th>
              <th>期望绝对时刻</th>
              <th className="num">期望偏移</th>
              <th className="num">实际时刻</th>
              <th className="num">实际偏移</th>
              <th className="num">相对期望偏差</th>
            </tr>
          </thead>
          <tbody>
            {schedule.events.map((s) => {
              const ev = events[s.eventIdx]
              const isAnchor = s.eventIdx === schedule.anchorIdx
              return (
                <tr key={ev.id} className={`${s.hitsBound ? 'hit-bound' : ''}`}>
                  <td>
                    {ev.name}
                    {isAnchor && <span className="badge anchor" style={{ marginLeft: 6 }}>锚点</span>}
                    {s.hitsBound && <span className="badge d-hit" style={{ marginLeft: 6 }}>达到 ±D</span>}
                  </td>
                  <td>
                    {s.timed ? (
                      <span className="status-pill bounded">已定时</span>
                    ) : (
                      <span className="status-pill disconnected" title="与锚点之间没有任何约束通路">
                        未定时
                      </span>
                    )}
                  </td>
                  <td>
                    {isAnchor ? (
                      <span className="cell-na">锚点不可填期望</span>
                    ) : (
                      <input
                        type="datetime-local"
                        value={expectedTimes[ev.id] ?? ''}
                        onChange={(e) => onExpectedChange(ev.id, e.target.value)}
                        aria-label={`${ev.name} 期望时刻`}
                        title={
                          s.timed
                            ? '期望绝对时刻；参与整体最小偏差求解'
                            : '该事件尚未与锚点连通：期望会保存，但不参与求解（标记为未定时）'
                        }
                      />
                    )}
                  </td>
                  <td className="num">
                    {isAnchor ? '—' : formatSignedMin(s.expectedOffset)}
                  </td>
                  <td className="num">
                    {s.timed ? formatAbsolute(anchorTime, s.actualOffset) : '—'}
                  </td>
                  <td className="num">{s.timed ? formatSignedMin(s.actualOffset) : '—'}</td>
                  <td className="num">
                    {s.deviation === null ? (
                      '—'
                    ) : (
                      <span
                        className="dev-value"
                        title={describeDeviation(s.deviation)}
                      >
                        {formatSignedMin(s.deviation)}
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="schedule-legend">
        说明：实际时刻为整体搜索得到的<strong>确定性可行解</strong>（同一输入结果不变）；
        偏差 = 实际 − 期望，正值表示晚于期望、负值表示早于期望；
        达到 <code>±D</code> 的事件以绿色高亮。编辑约束、锚点或期望时刻后立即重算；
        系统矛盾或未设置锚点时不显示本排程。
      </div>
    </div>
  )
}
