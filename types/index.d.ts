export type Tab = 'overview' | 'models'
export type Range = 'all' | '30d' | '7d'

declare module 'claude-code' {
  interface PluginState {
    'stats-heatmap': { tab: Tab; range: Range }
  }
}
