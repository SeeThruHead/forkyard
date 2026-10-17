import { type ReactNode, useState } from "react"
import { InfraName, ownerOfWorktree, type RunId, ServiceName } from "../../src/Ids.ts"
import { runOf, type Snapshot, type WorktreeView } from "../../src/Model.ts"
import { mapleLink, mapleUrl } from "./forkyard.ts"
import { Branch, branchOrder, EnvTable, Frames, InfraChips, Logs, RestartButton, ServiceChips } from "./ui.tsx"

type Step = {
  readonly title: string
  readonly body: (context: Context) => ReactNode
}

type Context = {
  readonly snapshot: Snapshot
  readonly project: (name: string) => ReadonlyArray<WorktreeView>
  readonly pick: (project: string, branch: string) => WorktreeView | undefined
}

const Missing = ({ what }: { readonly what: string }) => <p className="empty">{what} is not running. Start the tour with pnpm run tour.</p>

const versionOf = (worktree: WorktreeView, service: ServiceName) => {
  const view = worktree.services[service]
  return view ? `${runOf(view.state)?.run ?? 0}-${view.state._tag}` : "none"
}

const LiveLogs = ({ worktree, service }: { readonly worktree: WorktreeView; readonly service: ServiceName }) => {
  const [runId, setRunId] = useState<RunId | undefined>(undefined)
  const version = versionOf(worktree, service)

  if (!worktree.services[service]) return <Missing what={service} />
  return <Logs key={version} owner={ownerOfWorktree(worktree.id)} service={service} version={version} runId={runId} onPick={setRunId} />
}

const api = ServiceName.make("api")

const web = ServiceName.make("web")

const TemporalLink = ({ worktree }: { readonly worktree: WorktreeView }) => {
  const view = worktree.infra[InfraName.make("temporal")]
  const url = view?._tag === "InfraReady" ? view.url : undefined
  return url ? (
    <a href={url} target="_blank" rel="noreferrer">
      Temporal UI
    </a>
  ) : (
    <>starting</>
  )
}

const steps: ReadonlyArray<Step> = [
  {
    title: "What is running",
    body: ({ snapshot }) => (
      <>
        <p>
          Three example repos are checked out on several branches each, and every copy was started with <code>forkyard up</code>. One daemon
          runs all of them. Nothing listens on a fixed port: every web service gets a random port and a name like{" "}
          <code>shop.feat-gift-cards.storefront.localhost</code>, and Traefik routes the name to whatever port the process has right now.
        </p>
        <table>
          <thead>
            <tr>
              <th>Repo</th>
              <th>Branch</th>
              <th>Services</th>
              <th>Infrastructure</th>
            </tr>
          </thead>
          <tbody>
            {Object.values(snapshot)
              .sort((a, b) => a.project.localeCompare(b.project) || branchOrder(a, b))
              .map((worktree) => (
                <tr key={worktree.id}>
                  <td>{worktree.project}</td>
                  <td>
                    <Branch name={worktree.branch} />
                  </td>
                  <td>
                    <ServiceChips worktree={worktree} />
                  </td>
                  <td>
                    <InfraChips worktree={worktree} />
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        <p className="callout">
          storefront is shaped like a typical product monorepo (pnpm, varlock, Postgres, Temporal). shortly makes different ones (Bun, plain
          .env files, Redis). taskboard is a Python app whose env lives in docker-compose.yml. The daemon knows none of those tools; each
          repo describes itself in a forkyard.config.ts.
        </p>
      </>
    )
  },
  {
    title: "One app, three branches",
    body: ({ project }) => (
      <>
        <p>
          These are the shops of three storefront branches, live. Place an order in one of them, then refresh the others: the order only
          exists on that branch, because each branch has its own database. feat-gift-cards also shows a Gift cards section, because that
          branch adds a migration the others do not have.
        </p>
        <Frames worktrees={project("storefront")} service="shop" />
      </>
    )
  },
  {
    title: "A database per branch, one Postgres",
    body: ({ project }) => (
      <>
        <p>
          This is the API. Look at the database and migrations rows. There is one Postgres container for every repo and branch (it is marked
          shared on the first page). Each storefront branch got its own database by cloning <code>storefront_golden</code> inside that
          server, which took well under a second, and then ran only the migrations its branch adds. shortly uses the same server with empty
          databases instead of a template.
        </p>
        <Frames worktrees={project("storefront")} service="api" />
      </>
    )
  },
  {
    title: "A Temporal server per branch",
    body: ({ project }) => (
      <>
        <p>
          storefront asks for Temporal with <code>scope: "worktree"</code>, so every branch has its own server with the same three
          namespaces, and the Temporal UI never shows another branch's work. Queue a job in one backoffice below: that branch's workers run
          it within a second and the other branches never see it. Changing one word in the config to <code>"shared"</code> would give one
          server with prefixed namespaces instead.
        </p>
        <p>
          {project("storefront").map((worktree) => (
            <span key={worktree.id} style={{ marginRight: 14 }}>
              <Branch name={worktree.branch} /> <TemporalLink worktree={worktree} />
            </span>
          ))}
        </p>
        <Frames worktrees={project("storefront")} service="backoffice" />
      </>
    )
  },
  {
    title: "Where every env value came from",
    body: ({ pick }) => {
      const worktree = pick("storefront", "feat-gift-cards")
      if (!worktree) return <Missing what="storefront feat-gift-cards" />
      return (
        <>
          <p>
            This is the exact env the API on feat-gift-cards was started with. varlock still reads the repo's <code>.env.schema</code>, and
            the values that come from the secret manager (here a fake script) pass through untouched, like the auth issuer. forkyard only
            replaces what the config says it owns: the database and Temporal come from the infrastructure, the service URLs from the config.
            Because forkyard hands its values to varlock, values derived from them follow along: <code>API_GRAPHQL_URL</code> is built from{" "}
            <code>API_URL</code> in the schema. Secrets are masked. Anything still pointing at a fixed localhost port is flagged.
          </p>
          <EnvTable id={worktree.id} service={api} version={versionOf(worktree, api)} />
        </>
      )
    }
  },
  {
    title: "Restart one thing, keep every log",
    body: ({ pick }) => {
      const worktree = pick("storefront", "fix-checkout")
      if (!worktree) return <Missing what="storefront fix-checkout" />
      return (
        <>
          <p>
            Press restart. Only fix-checkout's API stops: its process scope closes, which kills the process, removes its route and closes
            its log. The supervisor starts it again on a new port and the name keeps working. Every run's output is kept in SQLite, so the
            previous run is still in the list below.
          </p>
          <p>
            <RestartButton id={worktree.id} service={api} />
          </p>
          <LiveLogs worktree={worktree} service={api} />
        </>
      )
    }
  },
  {
    title: "A Bun app that uses .env files",
    body: ({ project, pick }) => {
      const worktree = pick("shortly", "feat-tags") ?? project("shortly")[0]
      return (
        <>
          <p>
            shortly has no varlock and no Temporal. Its config reads <code>.env</code> then <code>.env.local</code>, shares the same
            Postgres server, and gives each branch its own Redis process. Shorten a link in one: that branch's worker checks it through that
            branch's Redis queue.
            <code> ANALYTICS_URL</code> is deliberately left unmapped, so the env view below warns about it.
          </p>
          <Frames worktrees={project("shortly")} service="web" />
          {worktree ? (
            <>
              <h2>api env on {worktree.branch}</h2>
              <EnvTable id={worktree.id} service={api} version={versionOf(worktree, api)} />
            </>
          ) : null}
        </>
      )
    }
  },
  {
    title: "A Python app configured by docker compose",
    body: ({ project, pick }) => {
      const worktree = pick("taskboard", "feat-due-dates") ?? project("taskboard")[0]
      return (
        <>
          <p>
            taskboard's team normally runs it with docker compose. forkyard reads each service's environment from{" "}
            <code>docker-compose.yml</code> (including
            <code> env_file</code> and <code>{"${LOG_LEVEL:-info}"}</code> interpolation) and runs the same Python natively. Compose-only
            addresses like
            <code> http://api:8000</code> are replaced with the branch's name. Its database is a SQLite file inside each branch's checkout.
          </p>
          <Frames worktrees={project("taskboard")} service="web" />
          {worktree ? (
            <>
              <h2>web env on {worktree.branch}</h2>
              <EnvTable id={worktree.id} service={web} version={versionOf(worktree, web)} />
            </>
          ) : null}
        </>
      )
    }
  }
]

const telemetryStep: Step = {
  title: "Everything is traced in Maple",
  body: ({ project }) => (
    <>
      <p>
        forkyard starts its own Maple, owned by the daemon's scope like Traefik, and sends it everything over OpenTelemetry. Nothing here
        needs a collector.
      </p>
      <ul>
        <li>
          <strong>The daemon itself:</strong> every step is an <code>Effect.fn</code> span with the worktree, service and run as attributes.
          Each service run is its own trace: env resolution (one span per source), spawn, the health checks, and a span that lasts as long
          as the process. Metrics count starts, exits and restarts and time how long services take to become ready.{" "}
          <a href={mapleLink("traces", { service: "forkyard" })} target="_blank" rel="noreferrer">
            forkyard's traces
          </a>
        </li>
        <li>
          <strong>Every process's output:</strong> forkyard ships each line as an OTLP log under the service's own name, with the worktree
          as its namespace, linked to that run's trace. This works for apps with no OpenTelemetry at all, like the Bun and Python examples.{" "}
          <a href={mapleLink("logs", { service: "worker" })} target="_blank" rel="noreferrer">
            worker logs across repos
          </a>
        </li>
        <li>
          <strong>The apps:</strong> forkyard gives each process <code>OTEL_EXPORTER_OTLP_ENDPOINT</code>, <code>OTEL_SERVICE_NAME</code>{" "}
          and the worktree as <code>service.namespace</code>. storefront turns on Node auto-instrumentation in its config, so a page load is
          one trace from the shop through the API to Postgres, separate for every branch.
        </li>
        <li>
          <strong>This dashboard:</strong> the browser sends its spans through the daemon, and the RPC carries the trace across the
          websocket, so a click here and the daemon work it caused are one trace.
        </li>
      </ul>
      <p>
        {project("storefront").map((worktree) => (
          <span key={worktree.id} style={{ marginRight: 14 }}>
            <Branch name={worktree.branch} />{" "}
            <a href={mapleLink("traces", { ns: worktree.id })} target="_blank" rel="noreferrer">
              traces
            </a>
          </span>
        ))}
        <a href={mapleUrl} target="_blank" rel="noreferrer">
          Open Maple
        </a>
      </p>
    </>
  )
}

const allSteps: ReadonlyArray<Step> = [...steps, telemetryStep]

export const Tour = ({ snapshot, step }: { readonly snapshot: Snapshot; readonly step: number }) => {
  const index = Math.min(Math.max(step, 1), allSteps.length) - 1
  const current = allSteps[index]!
  const context: Context = {
    snapshot,
    project: (name) =>
      Object.values(snapshot)
        .filter((worktree) => worktree.project === name)
        .sort(branchOrder),
    pick: (project, branch) => Object.values(snapshot).find((worktree) => worktree.project === project && worktree.branch === branch)
  }
  return (
    <div className="tour">
      <div className="steps">
        {allSteps.map((item, position) => (
          <a key={item.title} href={`#/tour/${position + 1}`} className={position === index ? "on" : ""}>
            {position + 1}. {item.title}
          </a>
        ))}
      </div>
      <div className="step">
        <h1>
          {index + 1}. {current.title}
        </h1>
        {current.body(context)}
        <p style={{ marginTop: 18 }}>
          {index > 0 ? (
            <a className="btn light" href={`#/tour/${index}`}>
              Back
            </a>
          ) : null}{" "}
          {index < allSteps.length - 1 ? (
            <a className="btn" href={`#/tour/${index + 2}`}>
              Next: {allSteps[index + 1]!.title}
            </a>
          ) : null}
        </p>
      </div>
    </div>
  )
}
