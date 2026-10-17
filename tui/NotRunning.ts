import { Box, Text, useInput } from "ink"
import { createElement as h, useState } from "react"
import { ButtonBar, clickedButton, isClick, isMouseInput, type Mouse, place, useMouse } from "./Mouse.ts"
import { theme } from "./Theme.ts"

type Props = {
  readonly root: string
  readonly branch: string
  readonly rows: number
  readonly onStart: () => Promise<void>
  readonly onBack: () => void
  readonly onQuit: () => void
}

const startRow = 5

export const NotRunning = ({ root, branch, rows, onStart, onBack, onQuit }: Props) => {
  const [status, setStatus] = useState<{ readonly busy: boolean; readonly error: string }>({ busy: false, error: "" })

  const start = () => {
    if (status.busy) return
    setStatus({ busy: true, error: "" })
    onStart().catch((error: unknown) => setStatus({ busy: false, error: String(error) }))
  }

  const buttons = place([
    { label: " ◀ worktrees ", action: onBack },
    { label: " ▶ start ", action: start },
    { label: " q quit ", action: onQuit }
  ])

  const onMouse = (event: Mouse) => {
    if (!isClick(event)) return
    if (event.y === rows) return clickedButton(buttons, event.x)?.action()
    if (event.y === startRow) return start()
  }

  useMouse(onMouse)

  useInput((input, key) => {
    if (isMouseInput(input)) return
    if (input === "q" || (key.ctrl && input === "c")) return onQuit()
    if (key.return) return start()
    if (key.escape || key.leftArrow) return onBack()
  })

  return h(
    Box,
    { flexDirection: "column", height: rows },
    h(
      Text,
      { wrap: "truncate" },
      h(Text, { bold: true, color: theme.accent }, "forkyard  "),
      h(Text, { color: theme.muted }, "◀ worktrees  "),
      h(Text, { bold: true, color: "#ffffff" }, branch),
      h(Text, { color: theme.muted }, `   ${root}`)
    ),
    h(
      Box,
      { flexDirection: "column", flexGrow: 1, borderStyle: "round", borderColor: theme.border, paddingX: 1 },
      h(Text, { color: theme.text }, `This checkout (${branch}) is not running.`),
      h(Text, null, ""),
      h(
        Text,
        { backgroundColor: theme.buttonBg, color: status.busy ? theme.starting : theme.ready },
        status.busy ? " starting… " : " ▶ Start this worktree "
      ),
      h(Text, null, ""),
      status.error
        ? h(Text, { color: theme.failed }, status.error)
        : h(Text, { color: theme.muted }, "⏎ or click to start. It opens here as its services come up.")
    ),
    h(ButtonBar, { buttons, note: "⏎ start · esc worktrees" })
  )
}
