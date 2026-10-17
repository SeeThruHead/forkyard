import pg from "pg"

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
const namespace = process.env.TEMPORAL_NAMESPACE_FULFILLMENT
const who = `workers pid ${process.pid} (${namespace} on ${process.env.TEMPORAL_ADDRESS})`

const namespaces = await fetch(`${process.env.TEMPORAL_HTTP_URL}/api/v1/namespaces`)
  .then((response) => response.json())
  .then((body) => body.namespaces.map((item) => item.namespaceInfo.name).join(", "))
  .catch((error) => `unreachable (${error.message})`)
const database = (await pool.query("SELECT current_database() AS name")).rows[0].name

console.log(`workers started: database ${database}, temporal namespaces ${namespaces}`)

const claim = `
  UPDATE jobs SET status = 'done', finished_at = now(), done_by = $1
  WHERE id = (SELECT id FROM jobs WHERE status = 'pending' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
  RETURNING id, kind`

const tick = async () => {
  const { rows } = await pool.query(claim, [who])
  rows.forEach((row) => console.log(`ran job ${row.id} (${row.kind})`))
}

setInterval(() => tick().catch((error) => console.error(`tick failed: ${error.message}`)), 1000)
