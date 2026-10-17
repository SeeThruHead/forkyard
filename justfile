# List the recipes
default:
    @just --list

# Install everything, including the example repos and the git hooks
setup:
    pnpm install
    pnpm --dir examples/storefront install
    bun install --cwd examples/bun-dotenv

# Run the daemon in the foreground (Traefik on port 80, Maple, the dashboard)
daemon:
    pnpm run daemon

# Start the worktree in the current directory
up *args:
    ./bin/forkyard up {{args}}

# Format, lint, typecheck and test
check:
    pnpm run check

# Format every file in place
format:
    pnpm run format

# Build the browser dashboard
dashboard:
    pnpm run build:dashboard

# Start seven branches of the examples and check they are independent
tour:
    pnpm run tour
