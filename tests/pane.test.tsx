import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'stats-heatmap',
  component: 'Pane',
  requestId: 'stats-heatmap',
  props: {
    title: 'Stats',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const STATS = {
  totalSessions: 1234,
  totalMessages: 50,
  hourCounts: { '2': 9, '14': 3 },
  dailyActivity: [
    { date: '2026-10-24', messageCount: 5, sessionCount: 1 }, // a Saturday
    { date: '2026-10-26', messageCount: 40, sessionCount: 2 }, // a Monday
    { date: '2026-10-27', messageCount: 5, sessionCount: 1 },
    { date: '2026-10-28', messageCount: 5, sessionCount: 1 },
  ],
  dailyModelTokens: [
    { date: '2026-09-01', tokensByModel: { 'claude-haiku-5-5': 9_000_000 } },
    { date: '2026-10-26', tokensByModel: { 'claude-opus-5-5': 2_000_000 } },
  ],
}

const setup = (on: On) => {
  // Thursday 2026-10-29, local noon.
  mock.clock(on, { now: new Date(2026, 9, 29, 12).getTime() })
  mock.env(on, { USERPROFILE: 'C:/u' })
  const paths: string[] = []
  on('fs.read', (_, e) => {
    paths.push(e.path.replace(/\\/g, '/'))
    return { value: JSON.stringify(STATS) }
  })
  return paths
}
// The innermost Box that starts with the label is its card.
const value = async (ui: { findAll: Function }, label: string) => {
  const boxes: { text: string }[] = await ui.findAll({ type: 'Box', text: new RegExp(`^${label}`) })
  return boxes.sort((a, b) => a.text.length - b.text.length)[0]?.text.slice(label.length)
}

test('the overview shows the stat cards', async ($, on) => {
  const paths = setup(on)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(paths.at(-1)).toBe('C:/u/.claude/stats-cache.json')
    expect(await value(ui, 'Sessions')).toBe('1,234')
    expect(await value(ui, 'Total tokens')).toBe('11.0M')
    expect(await value(ui, 'Current streak')).toBe('3d')
    expect(await value(ui, 'Peak hour')).toBe('2 AM')
    expect(await value(ui, 'Favorite model')).toBe('Haiku 5.5')
    await ui.unmount()
  }
})

test('the ranges narrow the totals', async ($, on) => {
  setup(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: '7d' })
  expect(await value(ui, 'Sessions')).toBe('5')
  expect(await value(ui, 'Total tokens')).toBe('2.0M')
  expect(await value(ui, 'Favorite model')).toBe('Opus 5.5')
  await ui.unmount()
})

test('each day lands on its weekday', async ($, on) => {
  setup(on)

  // Desktop: 18 weeks fit in 40 columns; the last column (x 221) is the week of the 25th, Monday in row 1.
  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svg = String((await desktop.find({ type: 'Svg' }))?.props.source)
  expect(svg).toContain('x="221" y="13" width="11" height="11" rx="2" fill="#1f6fe5"><title>Oct 26: 40 messages · 2.0M tokens</title>')
  await desktop.unmount()

  // Terminal: Friday the 30th is still to come, so that row ends on the idle 23rd, not the Saturday 24th.
  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await terminal.find({ type: 'Text', text: /^Mon / }))?.text.trimEnd().endsWith('█')).toBe(true)
  expect((await terminal.find({ type: 'Text', text: /^Fri / }))?.text.trimEnd().endsWith('·')).toBe(true)
  await terminal.unmount()
})

test('the models tab lists each model with its share', async ($, on) => {
  setup(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'Models' })
  expect(await value(ui, 'Haiku 5.5')).toBe('9.0M')
  expect(await value(ui, 'Opus 5.5')).toBe('2.0M')
  await ui.unmount()
})

test('/heatmap auto on|off decides whether a session start opens the pane; /heatmap always does', async ($, on) => {
  mock.store(on)
  let opened = 0
  on('command.register', () => ({ value: { command: 'heatmap' } }))
  on('ui.open', () => {
    opened++
    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const start = () => $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // The kit fills in the origin and presentation a typed command carries.
  const run = (args: string) => $.command.run({ command: 'heatmap', args } as Parameters<typeof $.command.run>[0])

  await start()
  expect(opened).toBe(1)
  expect((await run('auto'))?.text).toContain('Auto-open is on')

  expect((await run('auto off'))?.text).toContain('no longer')
  await start()
  expect(opened).toBe(1)
  expect((await run('auto'))?.text).toContain('Auto-open is off')

  await run('')
  expect(opened).toBe(2)

  await run('auto on')
  await start()
  expect(opened).toBe(3)
})

test('a missing stats file draws a notice, not a blank pane', async ($, on) => {
  mock.env(on, { HOME: '/h' })
  on('fs.read', () => {
    throw new Error('ENOENT')
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /No stats yet/ }))?.text).toBeTruthy()
  await ui.unmount()
})
