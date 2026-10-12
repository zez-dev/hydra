/** The token-usage dashboard: overall totals, a day heatmap, and a per-model table. */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { UsageReportValue, UsageTotalsValue } from '@deepseek-ai/dsh-api-remotes/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { UsageInjected } from './face.ts'
import type { SidebarUsageKey } from './locales.ts'
import { UsageHeatmap } from './UsageHeatmap.tsx'
import css from './UsageBody.module.css'

export type { UsageInjected } from './face.ts'

/** Full component props assembled by the sidebar's keyed tab seat. */
export type UsageBodyProps =
  PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<'sidebarUsage'>
  & InjectFace<UsageInjected>

type Translate = UsageBodyProps['t']

/** Grouped digits, matching the figures the text `/usage` prints. */
const GROUPED = new Intl.NumberFormat('en-US')

/**
 * The breakdown under the headline total.
 *
 * Reasoning is indented under output and carries its own note, because the
 * Host counts it inside `outputTokens`; the four rows above it are the buckets
 * the headline total sums.
 */
const BREAKDOWN: readonly { readonly key: SidebarUsageKey; readonly pick: keyof UsageTotalsValue; readonly nested: boolean }[] = [
  { key: 'totals.input', pick: 'inputTokens', nested: false },
  { key: 'totals.output', pick: 'outputTokens', nested: false },
  { key: 'totals.cacheRead', pick: 'cacheReadTokens', nested: false },
  { key: 'totals.cacheWrite', pick: 'cacheWriteTokens', nested: false },
  { key: 'totals.reasoning', pick: 'reasoningTokens', nested: true },
]

type DashboardState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly report: UsageReportValue }

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Overall totals: the headline figure, the bucket breakdown, and the counts. */
function Totals({ totals, t }: { readonly totals: UsageTotalsValue; readonly t: Translate }): ReactNode {
  return (
    <section data-usage-section="totals">
      <div className={css.sectionHead}><h4>{t('totals.title')}</h4></div>
      <div className={css.headline}>
        <span className={css.headlineValue} data-usage-total={totals.totalTokens}>{GROUPED.format(totals.totalTokens)}</span>
        <span className={css.headlineUnit}>{t('totals.total')}</span>
      </div>
      <ul className={css.breakdown}>
        {BREAKDOWN.map(row => (
          <li key={row.key} className={css.breakdownRow} data-nested={String(row.nested)} data-usage-bucket={row.pick}>
            <span className={css.breakdownLabel}>{t(row.key)}</span>
            <span className={css.breakdownValue}>{GROUPED.format(totals[row.pick])}</span>
            {row.nested ? <span className={css.breakdownNote}>{t('totals.reasoningNote')}</span> : null}
          </li>
        ))}
      </ul>
      <div className={css.counts}>
        <span data-usage-count="messages">
          <span className={css.countValue}>{GROUPED.format(totals.messages)}</span>
          <span>{t('totals.messages')}</span>
        </span>
        <span data-usage-count="sessions">
          <span className={css.countValue}>{GROUPED.format(totals.sessions)}</span>
          <span>{t('totals.sessions')}</span>
        </span>
      </div>
    </section>
  )
}

/** The per-model table, descending by billable tokens as the Host ordered it. */
function ModelTable({ report, t }: { readonly report: UsageReportValue; readonly t: Translate }): ReactNode {
  return (
    <section data-usage-section="models">
      <div className={css.sectionHead}><h4>{t('models.title')}</h4></div>
      <table className={css.table}>
        <thead>
          <tr>
            <th scope="col">{t('models.provider')}</th>
            <th scope="col">{t('models.model')}</th>
            <th scope="col">{t('models.total')}</th>
            <th scope="col">{t('models.input')}</th>
            <th scope="col">{t('models.output')}</th>
            <th scope="col">{t('models.messages')}</th>
          </tr>
        </thead>
        <tbody>
          {report.byModel.map(entry => (
            <tr key={`${entry.provider}/${entry.model}`} data-usage-route={`${entry.provider}/${entry.model}`}>
              <td>{entry.provider}</td>
              <td>{entry.model}</td>
              <td>{GROUPED.format(entry.totals.totalTokens)}</td>
              <td>{GROUPED.format(entry.totals.inputTokens)}</td>
              <td>{GROUPED.format(entry.totals.outputTokens)}</td>
              <td>{GROUPED.format(entry.totals.messages)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

/**
 * The dashboard body.
 *
 * One unbounded report covers every section, so the totals and the table are
 * all-time like `/usage` and the heatmap clips its own window out of the day
 * series. There is no change feed behind the usage namespace, so the report is
 * re-read on demand rather than followed.
 * @param props - the tab seat's runtime, this package's copy, and the Remote face.
 * @returns the dashboard.
 */
export function UsageBody({ useTabInfo, report, t }: UsageBodyProps): ReactNode {
  const { tab } = useTabInfo()
  const [state, setState] = useState<DashboardState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  useEffect(() => {
    const controller = new AbortController()
    const onAbort = (): void => { controller.abort() }
    tab.signal.addEventListener('abort', onAbort, { once: true })
    // A refresh keeps the figures already on screen: only a read with nothing
    // to show falls back to the loading and failure views.
    setState(current => current.status === 'ready' ? current : { status: 'loading' })
    setBusy(true)
    void report({}).then(
      (value) => {
        if (controller.signal.aborted) return
        setNotice(undefined)
        setState({ status: 'ready', report: value })
        setBusy(false)
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setNotice(failureText(error))
        setState(current => current.status === 'ready' ? current : { status: 'error' })
        setBusy(false)
      },
    )
    return () => {
      tab.signal.removeEventListener('abort', onAbort)
      controller.abort()
    }
  }, [attempt, report, tab.signal])

  const refresh = useCallback(() => { setAttempt(count => count + 1) }, [])

  if (state.status === 'loading') return <div className={css.status}><p className={css.statusLine}>{t('loading')}</p></div>
  if (state.status === 'error') {
    return (
      <div className={css.status} data-usage-state="error">
        <p className={css.statusLine}>{t('error')}</p>
        {notice === undefined ? null : <p className={css.sectionNote} role="status">{notice}</p>}
        <Button size="sm" onClick={refresh}>{t('retry')}</Button>
      </div>
    )
  }
  const failed = notice === undefined ? null : <p className={css.sectionNote} role="status">{notice}</p>
  if (state.report.overall.messages === 0) {
    return (
      <div className={css.status} data-usage-state="empty">
        <p className={css.statusLine}>{t('empty')}</p>
        {failed}
        <Button size="sm" disabled={busy} onClick={refresh}>{busy ? t('refreshing') : t('refresh')}</Button>
      </div>
    )
  }
  return (
    <div className={css.root} data-usage-state="ready">
      <Totals totals={state.report.overall} t={t} />
      <UsageHeatmap days={state.report.days} today={new Date()} t={t} />
      <ModelTable report={state.report} t={t} />
      <div>
        {failed}
        <Button size="sm" variant="ghost" disabled={busy} onClick={refresh}>{busy ? t('refreshing') : t('refresh')}</Button>
      </div>
    </div>
  )
}
