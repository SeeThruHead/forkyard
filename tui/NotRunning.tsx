import { Box, Text, useInput } from "ink"
import { useState } from "react"
import { ButtonBar } from "./ButtonBar.tsx"
import { clickedButton, isClick, isMouseInput, type Mouse, place, useMouse } from "./Mouse.ts"
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

  return (
    <Box flexDirection="column" height={rows}>
      <Text wrap="truncate">
        <Text bold color={theme.accent}>
          forkyard{"  "}
        </Text>
        <Text color={theme.muted}>◀ worktrees{"  "}</Text>
        <Text bold color="#ffffff">
          {branch}
        </Text>
        <Text color={theme.muted}>{`   ${root}`}</Text>
      </Text>
      <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={theme.border} paddingX={1}>
        <Text color={theme.text}>This checkout ({branch}) is not running.</Text>
        <Text> </Text>
        <Text backgroundColor={theme.buttonBg} color={status.busy ? theme.starting : theme.ready}>
          {status.busy ? " starting… " : " ▶ Start this worktree "}
        </Text>
        <Text> </Text>
        {status.error ? (
          <Text color={theme.failed}>{status.error}</Text>
        ) : (
          <Text color={theme.muted}>⏎ or click to start. It opens here as its services come up.</Text>
        )}
      </Box>
      <ButtonBar buttons={buttons} note="⏎ start · esc worktrees" />
    </Box>
  )
}
