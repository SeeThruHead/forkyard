import { Text } from "ink"
import type { PlacedButton } from "./Mouse.ts"
import { theme } from "./Theme.ts"

export const ButtonBar = ({ buttons, note }: { readonly buttons: ReadonlyArray<PlacedButton>; readonly note: string }) => (
  <Text wrap="truncate">
    {buttons.map((button) => (
      <Text key={button.label}>
        {" "}
        <Text backgroundColor={theme.buttonBg} color={theme.buttonText}>
          {button.label}
        </Text>
      </Text>
    ))}
    <Text color={theme.muted}>{`   ${note}`}</Text>
  </Text>
)
