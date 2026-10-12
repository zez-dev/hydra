/** The contribution heatmap: one column per week, one row per weekday, the last 12 months. */
import { useEffect, useRef, type ReactNode } from 'react'
import type { UsageDayValue } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { buildHeatmap, type Heatmap } from './grid.ts'
import css from './UsageBody.module.css'

/** Namespace-bound translate for this package's copy. */
type Translate = PropsLocale<'sidebarUsage'>['t']

/** Grouped digits, matching the figures the text `/usage` prints. */
const GROUPED = new Intl.NumberFormat('en-US')

/** Weekday rows, Sunday first, matching `Date.getDay()`. */
const WEEKDAY_KEYS = [
  'weekday.0', 'weekday.1', 'weekday.2', 'weekday.3', 'weekday.4', 'weekday.5', 'weekday.6',
] as const

/** Month labels by `Date.getMonth()`. */
const MONTH_KEYS = [
  'month.0', 'month.1', 'month.2', 'month.3', 'month.4', 'month.5',
  'month.6', 'month.7', 'month.8', 'month.9', 'month.10', 'month.11',
] as const

/** What the heatmap needs to draw itself. */
export interface UsageHeatmapProps {
  /** The report's day series, ascending, with idle days omitted. */
  readonly days: readonly UsageDayValue[]
  /** The local day the window ends on. */
  readonly today: Date
  readonly t: Translate
}

/**
 * The grid of one week per column and one weekday per row.
 *
 * Squares scroll horizontally and open on the most recent week, because the
 * sidebar is narrower than a year of columns. A day that recorded nothing is a
 * level-0 square, not a gap: {@link buildHeatmap} fills in the days the report
 * omits.
 * @param props - the day series, the day the window ends on, and the translate.
 * @returns the heatmap section.
 */
export function UsageHeatmap({ days, today, t }: UsageHeatmapProps): ReactNode {
  const scroll = useRef<HTMLDivElement>(null)
  const heatmap: Heatmap = buildHeatmap(days, today)

  useEffect(() => {
    const element = scroll.current
    if (element === null) return
    element.scrollLeft = element.scrollWidth
  }, [heatmap.to])

  return (
    <section data-usage-section="heatmap">
      <div className={css.sectionHead}>
        <h4>{t('heatmap.title')}</h4>
        <span className={css.sectionNote}>{t('heatmap.range', { from: heatmap.from, to: heatmap.to })}</span>
      </div>
      <div className={css.scroll} ref={scroll}>
        <div className={css.grid}>
          <div className={css.weekdays}>
            {WEEKDAY_KEYS.map(key => <span key={key} className={css.weekdayLabel}>{t(key)}</span>)}
          </div>
          <div className={css.columns}>
            <div className={css.months} aria-hidden="true">
              {heatmap.weeks.map(week => (
                <span key={week.start} className={css.monthLabel}>
                  {week.monthLabel === undefined ? '' : t(MONTH_KEYS[week.monthLabel] ?? 'month.0')}
                </span>
              ))}
            </div>
            <div className={css.weeks}>
              {heatmap.weeks.map(week => (
                <div key={week.start} className={css.week} data-week={week.start}>
                  {week.cells.map((cell, weekday) => cell.kind === 'padding'
                    ? <span key={weekday} className={css.pad} />
                    : (
                      <span
                        key={weekday}
                        className={css.cell}
                        data-day={cell.day}
                        data-level={cell.level}
                        data-tokens={cell.tokens}
                        title={cell.tokens === 0
                          ? t('heatmap.cellEmpty', { date: cell.day })
                          : t('heatmap.cell', { date: cell.day, tokens: GROUPED.format(cell.tokens) })}
                      />
                    ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className={css.legend}>
        <span>{t('heatmap.legendLess')}</span>
        {[0, 1, 2, 3, 4].map(level => <span key={level} className={css.cell} data-level={level} />)}
        <span>{t('heatmap.legendMore')}</span>
        <span className={css.legendScale}>
          {t('heatmap.legendScale', { tokens: GROUPED.format(heatmap.busiest) })}
        </span>
      </div>
      <p className={css.sectionNote}>
        {t('heatmap.activeDays', {
          days: GROUPED.format(heatmap.activeDays),
          tokens: GROUPED.format(heatmap.total),
        })}
      </p>
    </section>
  )
}
