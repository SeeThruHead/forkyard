import { useStdin, useStdout } from "ink"
import { useEffect } from "react"

export type Mouse = { readonly button: number; readonly x: number; readonly y: number; readonly press: boolean }

export type Button = { readonly label: string; readonly action: () => void }

export type PlacedButton = Button & { readonly from: number; readonly to: number }

const mouseSequence = /\[<(\d+);(\d+);(\d+)([mM])/g

const parseMouse = (data: string): ReadonlyArray<Mouse> =>
  [...data.matchAll(mouseSequence)].map((match) => ({
    button: Number(match[1]),
    x: Number(match[2]),
    y: Number(match[3]),
    press: match[4] === "M"
  }))

export const isMouseInput = (input: string) => /\[<\d+;\d+;\d+[mM]/.test(input)

export const isWheel = (event: Mouse) => (event.button & 64) === 64

export const isWheelDown = (event: Mouse) => isWheel(event) && (event.button & 1) === 1

export const isClick = (event: Mouse) => event.press && !isWheel(event) && (event.button & 3) === 0 && (event.button & 32) === 0

const enableMouse = "\u001b[?1000h\u001b[?1002h\u001b[?1006h"
const disableMouse = "\u001b[?1000l\u001b[?1002l\u001b[?1006l"

export const useMouseMode = () => {
  const { stdout } = useStdout()
  useEffect(() => {
    stdout.write(enableMouse)
    const restore = () => process.stdout.write(disableMouse)
    process.once("exit", restore)
    return () => {
      stdout.write(disableMouse)
      process.off("exit", restore)
    }
  }, [stdout])
}

export const useMouse = (onMouse: (event: Mouse) => void) => {
  const { stdin } = useStdin()
  useEffect(() => {
    const listener = (data: Buffer | string) => parseMouse(String(data)).forEach(onMouse)
    stdin.on("data", listener)
    return () => {
      stdin.off("data", listener)
    }
  })
}

export const place = (buttons: ReadonlyArray<Button>): ReadonlyArray<PlacedButton> =>
  buttons.reduce<ReadonlyArray<PlacedButton>>((placed, button) => {
    const from = (placed.at(-1)?.to ?? 0) + 2
    return [...placed, { ...button, from, to: from + [...button.label].length - 1 }]
  }, [])

export const clickedButton = (buttons: ReadonlyArray<PlacedButton>, x: number) =>
  buttons.find((button) => x >= button.from && x <= button.to)
