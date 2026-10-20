# Sharing services between worktrees

## Why

A large monorepo can take several gigabytes of memory per worktree when every worktree runs the whole stack. Most branches change one or two services, and most of the time nobody is using most of what runs. Sharing lets a project run many worktrees at once by running only what each one actually needs.

Sharing is off unless a config turns it on. A small project with a couple of services and SQLite does not need it: it runs a full stack per worktree, as before.

## Turning it on

```ts
export default make("shop", program, {
  inputs: moon({ services: { api: "api", web: "web" } }),
  shared: { ref: "origin/main", sleepAfter: "20 minutes" }
})
```

`inputs` tells forkyard which files belong to each service and infra, so it can tell what a branch changed. `shared.ref` is the commit the shared stack runs.

## The shared stack

Forkyard keeps one extra checkout per project and profile, a `git clone --shared` in its home directory at `shared.ref`. Nobody edits it, so what runs there never changes under anyone. It runs as a stack of its own, visible as `shared.<project>`, and starts a service only while some worktree needs it. `forkyard shared update` moves it to the latest commit of the ref and restarts what it runs.

## What a worktree runs itself

A service runs in the worktree, instead of in the shared stack, when any of these hold:

- the branch changed its files: the diff from where the branch forked, plus uncommitted and untracked files;
- the agent asked for it with `forkyard own <service>` (`forkyard share` undoes that);
- it calls a service that runs here (`calls`), so its requests reach the changed code;
- it uses infra that runs here, such as the worktree's own database after a migration.

Infra runs here when its own files changed (migrations for a database), or when a service that runs here reads from it (`consumes`). That second rule keeps a worker on a branch from taking messages meant for the shared one: it gets its own queue, namespace or prefix.

Tasks follow the services that need them. A task runs here when something running here waits on it, unless it sets up infra that is shared (`prepares`): migrations for the shared database run once, in the shared stack. Infra every worktree uses as it is, like a telemetry collector or a mail catcher (`sharedBy`), never decides where anything runs.

Once a service runs here it stays here until `forkyard share`, so working state is not lost when a change is undone.

## Starting on demand

Nothing starts until something needs it:

- what the branch changed starts right away;
- `forkyard start <service>` starts a service, here or in the shared stack, with what it waits on; `forkyard stop` undoes it;
- a request to a sleeping service's hostname starts it. Forkyard holds that first request until the service is ready, then passes it through, and later requests go straight to the service.

Every worktree keeps its own hostnames whether a service runs here or is shared; the proxy points each name at whichever copy serves it.

## Sleeping again

Services that were started on request go back to sleep after `sleepAfter` with no requests, measured from the proxy's per-route request counters. What a worktree runs because the branch changed it stays up. A shared service stops once no worktree needs it.

## Databases

A worktree that runs its own database gets one cloned from the golden copy, which is cheap on a filesystem that shares blocks. Forkyard records which worktree used which tenant and when, and drops a tenant nobody has used for a week, unless it is the latest one of a worktree that still exists or something is connected to it.
