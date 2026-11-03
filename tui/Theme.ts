export const theme = {
  text: "#d7dae0",
  muted: "#9aa3b2",
  faint: "#737c8c",
  border: "#5a6372",
  borderActive: "#6aa9ff",
  accent: "#6aa9ff",
  selectedBg: "#23395b",
  buttonBg: "#2f3644",
  buttonText: "#dfe3ea",
  matchBg: "#7a5a12",
  matchText: "#fff4d6",
  ready: "#5fd38d",
  done: "#45c6bd",
  starting: "#f2c14e",
  waiting: "#9aa3b2",
  restarting: "#c49bff",
  failed: "#ff7b7b",
  shared: "#7dcfff"
} as const

const stateColors: Readonly<Record<string, string>> = {
  Ready: theme.ready,
  Done: theme.done,
  Starting: theme.starting,
  Preparing: theme.starting,
  Waiting: theme.waiting,
  Restarting: theme.restarting,
  Failed: theme.failed,
  InfraReady: theme.ready,
  InfraStarting: theme.starting,
  InfraFailed: theme.failed
}

export const stateColor = (state: string) => stateColors[state] ?? theme.muted

const palette = ["#6aa9ff", "#c49bff", "#45c6bd", "#f2c14e", "#5fd38d", "#ff9e64", "#7dcfff", "#e0af68", "#bb9af7", "#9ece6a"]

export const keyColor = (key: string): string =>
  palette[key.split("").reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 997, 7) % palette.length] ?? theme.accent
