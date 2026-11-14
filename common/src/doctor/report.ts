import type { DoctorFinding, DoctorReport, DoctorSeverity } from './types'

const LABEL: Record<DoctorSeverity, string> = { error: 'Problem', warning: 'Warning', info: 'Note', ok: 'OK' }

function doctorCounts(report: Pick<DoctorReport, 'findings'>) {
  const counts: Record<DoctorSeverity, number> = { error: 0, warning: 0, info: 0, ok: 0 }
  for (const item of report.findings) counts[item.severity]++
  return counts
}

export function doctorSummary(report: Pick<DoctorReport, 'findings'>) {
  const { error, warning } = doctorCounts(report)
  if (!error && !warning) return 'No problems found.'
  const parts = [
    error ? `${error} problem${error === 1 ? '' : 's'}` : null,
    warning ? `${warning} warning${warning === 1 ? '' : 's'}` : null,
  ].filter(Boolean)
  return `${parts.join(' and ')} found.`
}

function header(report: DoctorReport) {
  const product = report.product === 'desktop' ? 'Freebuff Desktop' : 'Freebuff CLI'
  return [
    `${product} ${report.appVersion ?? '(unknown version)'} on ${report.platform} ${report.arch}`,
    `Scanned ${report.generatedAt} in ${(report.durationMs / 1000).toFixed(1)} s` +
      `${report.options.deep ? ', deep scan' : ''}${report.options.includePaths ? ', full paths included' : ', paths redacted'}`,
  ]
}

function steps(item: DoctorFinding, bullet: string) {
  return item.steps.map((step, index) => `${bullet}${index + 1}. ${step}`)
}

/** The "Copy report" text: Markdown for a support ticket or Discord. Already redacted by the scan. */
export function doctorReportMarkdown(report: DoctorReport): string {
  const lines = ['## Freebuff diagnostics', '', ...header(report).map(line => `- ${line}`), `- ${doctorSummary(report)}`, '']
  const shown = report.findings.filter(item => item.severity !== 'ok')
  for (const item of shown) {
    lines.push(`### ${LABEL[item.severity]}: ${item.title}`, '', `\`${item.id}\` (${item.area})`, '', item.detail, '')
    if (item.steps.length) lines.push(...steps(item, ''), '')
    if (item.learnMore) lines.push(`More: ${item.learnMore}`, '')
  }
  const passed = report.findings.filter(item => item.severity === 'ok')
  if (passed.length) lines.push('### Passed', '', ...passed.map(item => `- ${item.title}`), '')
  const missing = report.checks.filter(check => check.outcome === 'timeout' || check.outcome === 'failed')
  if (missing.length) lines.push(`Checks that did not finish: ${missing.map(check => `${check.id} (${check.outcome})`).join(', ')}`, '')
  return lines.join('\n').trimEnd() + '\n'
}

/** Plain text for a terminal. */
export function doctorReportText(report: DoctorReport, options: { verbose?: boolean } = {}): string {
  const lines = ['Freebuff doctor', ...header(report), '']
  for (const item of report.findings) {
    if (item.severity === 'ok' && !options.verbose) continue
    lines.push(`[${LABEL[item.severity].toUpperCase()}] ${item.title}`, `  ${item.detail}`)
    lines.push(...steps(item, '  '))
    if (item.learnMore) lines.push(`  More: ${item.learnMore}`)
    lines.push('')
  }
  const passed = report.findings.filter(item => item.severity === 'ok').length
  lines.push(doctorSummary(report) + (passed && !options.verbose ? ` ${passed} checks passed.` : ''))
  return lines.join('\n') + '\n'
}

/**
 * The message "Ask Freebuff about this" puts in a new chat, for the user to read and send. It
 * carries only the redacted report the user can already see.
 */
export function doctorAskPrompt(report: DoctorReport): string {
  const product = report.product === 'desktop' ? 'Freebuff Desktop' : 'the Freebuff CLI'
  return [
    `${product}'s built-in diagnostics found the problems below on my computer.`,
    'Explain what each one means and walk me through fixing them, one at a time. Ask before running',
    'any command that changes files outside this project or changes system settings.',
    '',
    doctorReportMarkdown(report),
  ].join('\n')
}
