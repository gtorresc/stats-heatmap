import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register } from 'claude-code'

import type { Range, Tab } from '../types'

const PANE = 'stats-heatmap'
const DAY = 86_400_000
const WAR_AND_PEACE = 730_000 // tokens, roughly
const GLYPHS = ['·', '░', '▒', '▓', '█']
const BLUES = ['rgba(128,128,128,0.18)', '#a8c7fa', '#7cacf8', '#4c8df6', '#1f6fe5']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const LABELS = ['    ', 'Mon ', '    ', 'Wed ', '    ', 'Fri ', '    ']
const RANGES: [Range, string, number][] = [['all', 'All', Infinity], ['30d', '30d', 30], ['7d', '7d', 7]]

const tab = atom({ plugin: 'stats-heatmap', key: 'tab' } as const, 'overview' as Tab)
const range = atom({ plugin: 'stats-heatmap', key: 'range' } as const, 'all' as Range)

type Stats = {
  dailyActivity?: { date: string; messageCount: number; sessionCount?: number }[]
  dailyModelTokens?: { date: string; tokensByModel: Record<string, number> }[]
  totalSessions?: number
  totalMessages?: number
  hourCounts?: Record<string, number>
}

// Days are counted as UTC day numbers so a `YYYY-MM-DD` key never shifts with the timezone.
const dayOf = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  return Date.UTC(y!, m! - 1, d!) / DAY
}
const weekday = (day: number) => (day + 4) % 7 // 1970-01-01 was a Thursday
const monthOf = (day: number) => new Date(day * DAY).getUTCMonth()
const dateLabel = (day: number) => `${MONTHS[monthOf(day)]} ${new Date(day * DAY).getUTCDate()}`
const num = (n = 0) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const short = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n)
const modelName = (id: string) =>
  id.replace(/^claude-(\w+)-(\d+)-(\d+).*$/, (_, f: string, a, b) => `${f[0]!.toUpperCase()}${f.slice(1)} ${a}.${b}`)

// The engine's own stats file, the one the old /stats view read.
const statsPath = async ($: EngineInterface) => {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (dir) return `${dir}/stats-cache.json`
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return `${home}/.claude/stats-cache.json`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'heatmap',
      description: 'Show your usage stats; /heatmap auto on|off sets opening at session start',
    })
    // Kept in the mod's own store, which lasts across sessions; absent means on.
    if ((await $.store.get('autoOpen')) !== false) void $.ui.open({ id: PANE, title: 'Stats' })

    return next(e)
  })

  on('command.run', { command: 'heatmap' }, async ($, e) => {
    const [word, value] = e.args.trim().toLowerCase().split(/\s+/)
    if (word === 'auto') {
      if (value !== 'on' && value !== 'off') {
        const isOn = (await $.store.get('autoOpen')) !== false
        return { text: `Auto-open is ${isOn ? 'on' : 'off'}. Use /heatmap auto on or /heatmap auto off.` }
      }
      await $.store.set('autoOpen', value === 'on')
      return { text: `The Stats pane will ${value === 'on' ? 'now' : 'no longer'} open when a session starts.` }
    }

    await $.ui.open({ id: PANE, title: 'Stats' })

    return { text: 'Stats pane opened.' }
  })

  // The engine may rewrite the stats file as the session goes; redraw after each turn.
  on('turn.complete', async ($, e, next) => {
    $.ui.invalidate('ui.render')

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)

    let stats: Stats
    try {
      stats = JSON.parse(await $.fs.read(await statsPath($)))
    } catch {
      return <Text dimColor>No stats yet: they appear once Claude Code has recorded a session.</Text>
    }

    const shown = await read($, tab)
    const span = await read($, range)
    const now = new Date(await $.clock.now())
    const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY
    const from = today - RANGES.find(r => r[0] === span)![2] + 1
    const inRange = (date: string) => dayOf(date) >= from

    const counts = new Map<number, number>()
    let sessions = 0
    let messages = 0
    for (const a of stats.dailyActivity ?? []) {
      if (a.messageCount > 0) counts.set(dayOf(a.date), a.messageCount)
      if (inRange(a.date)) {
        sessions += a.sessionCount ?? 0
        messages += a.messageCount
      }
    }
    if (span === 'all') {
      sessions = stats.totalSessions ?? sessions
      messages = stats.totalMessages ?? messages
    }
    const activeDays = [...counts.keys()].filter(d => d >= from).length

    const byModel = new Map<string, number>()
    const dayTokens = new Map<number, number>()
    for (const t of stats.dailyModelTokens ?? []) {
      dayTokens.set(dayOf(t.date), Object.values(t.tokensByModel).reduce((sum, n) => sum + n, 0))
      if (!inRange(t.date)) continue
      for (const [model, n] of Object.entries(t.tokensByModel)) byModel.set(model, (byModel.get(model) ?? 0) + n)
    }
    const models = [...byModel].sort((a, b) => b[1] - a[1])
    const tokens = models.reduce((sum, [, n]) => sum + n, 0)

    const days = [...counts.keys()].sort((a, b) => a - b)
    let longest = 0
    let run = 0
    days.forEach((d, i) => {
      run = i > 0 && days[i - 1] === d - 1 ? run + 1 : 1
      longest = Math.max(longest, run)
    })
    // The cache can lag a day, so an idle today doesn't break the streak.
    let current = 0
    for (let d = counts.has(today) ? today : today - 1; counts.has(d); d--) current++

    const peak = Object.entries(stats.hourCounts ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0]
    const hour = peak === undefined ? '-' : `${Number(peak) % 12 || 12} ${Number(peak) < 12 ? 'AM' : 'PM'}`

    // Quartiles of the active days, so a few huge days don't flatten the rest.
    const sorted = [...counts.values()].sort((a, b) => a - b)
    const cuts = [1, 2, 3].map(k => sorted[Math.floor((k * sorted.length) / 4)]!)
    const level = (c = 0) => (c === 0 ? 0 : 1 + cuts.filter(q => c >= q).length)

    const weeks = Math.max(8, Math.min(53, Math.floor((e.props.bodyColumns - 4) / 2)))
    const start = today - weekday(today) - (weeks - 1) * 7
    const columns = Array.from({ length: weeks }, (_, w) => start + w * 7)

    const isTerminal = e.surface === 'terminal'
    const cardStyle = isTerminal
      ? { borderStyle: 'round', borderDimColor: true }
      : { backgroundColor: 'rgba(128,128,128,0.12)', paddingX: 'sm' as const, paddingY: 'xs' as const }
    const card = (label: string, value: string) => (
      <Box flexDirection="column" flexGrow={1} flexShrink={1} width={0} {...cardStyle}>
        <Text dimColor size="caption" wrap="truncate-end">{label}</Text>
        <Text weight="semibold" wrap="truncate-end">{value}</Text>
      </Box>
    )
    const choice = (isOn: boolean, label: string, press: () => unknown) => (
      <Button key={label} label={label} plain dimColor={!isOn} onPress={press} />
    )

    let heatmap
    if (isTerminal) {
      // A month's name sits over the first week that starts in it, when there is room.
      const header = Array<string>(weeks * 2).fill(' ')
      let free = 0
      columns.forEach((d, w) => {
        if (monthOf(d) !== monthOf(d - 7) && 2 * w >= free && 2 * w + 3 <= header.length) {
          header.splice(2 * w, 3, ...MONTHS[monthOf(d)]!)
          free = 2 * w + 4
        }
      })
      heatmap = (
        <Box flexDirection="column">
          <Text mono dimColor>{`    ${header.join('')}`}</Text>
          {LABELS.map((label, r) => (
            <Text mono>
              <Text dimColor>{label}</Text>
              {columns.map(c => {
                const d = c + r
                if (d > today) return <Text>{'  '}</Text>
                const l = level(counts.get(d))
                return l === 0 ? <Text dimColor>{'· '}</Text> : <Text color="suggestion">{`${GLYPHS[l]} `}</Text>
              })}
            </Text>
          ))}
        </Box>
      )
    } else {
      const cells = columns.flatMap((c, w) =>
        LABELS.map((_, r) => {
          const d = c + r
          if (d > today) return ''
          const n = counts.get(d) ?? 0
          return `<rect x="${w * 13}" y="${r * 13}" width="11" height="11" rx="2" fill="${BLUES[level(n)]}"><title>${dateLabel(d)}: ${num(n)} messages · ${short(dayTokens.get(d) ?? 0)} tokens</title></rect>`
        }),
      )
      const source = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 ${weeks * 13 - 2} ${7 * 13 - 2}">${cells.join('')}</svg>`
      // Every surface but the terminal carries Svg; `e.surface` alone doesn't narrow the table.
      const { Svg } = $.ui.resolve(e) as Elements['desktop']
      heatmap = <Svg source={source} alt={`Activity heatmap of the last ${weeks} weeks`} isInteractive />
    }

    const times = Math.round(tokens / WAR_AND_PEACE)

    return (
      <Box flexDirection="column" gap="sm">
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row" gap="sm">
            {choice(shown === 'overview', 'Overview', () => update($, tab, () => 'overview'))}
            {choice(shown === 'models', 'Models', () => update($, tab, () => 'models'))}
          </Box>
          <Box flexDirection="row" gap="sm">
            {RANGES.map(([r, label]) => choice(span === r, label, () => update($, range, () => r)))}
          </Box>
        </Box>
        {shown === 'overview' ? (
          <Box flexDirection="column" gap="sm">
            <Box flexDirection="row" gap="xs">
              {card('Sessions', num(sessions))}
              {card('Messages', num(messages))}
              {card('Total tokens', short(tokens))}
              {card('Active days', num(activeDays))}
            </Box>
            <Box flexDirection="row" gap="xs">
              {card('Current streak', `${current}d`)}
              {card('Longest streak', `${longest}d`)}
              {card('Peak hour', hour)}
              {card('Favorite model', models[0] ? modelName(models[0][0]) : '-')}
            </Box>
            {heatmap}
            {times >= 1 && <Text dimColor size="caption">You've used ~{num(times)}× more tokens than War and Peace.</Text>}
          </Box>
        ) : (
          <Box flexDirection="column" gap="xs">
            {models.length === 0 && <Text dimColor>No model usage in this range.</Text>}
            {models.map(([model, n]) => (
              <Box flexDirection="row" gap="xs">
                {card(modelName(model), short(n))}
                {card('Share', `${Math.round((100 * n) / tokens)}%`)}
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
