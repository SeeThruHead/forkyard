import { queueKey } from "@shortly/shared"
import { RedisClient, SQL } from "bun"

const sql = new SQL(process.env.DATABASE_URL!)
const redis = new RedisClient(process.env.REDIS_URL!)
const who = `worker pid ${process.pid}`

console.log(`worker started, polling ${queueKey()} on ${process.env.REDIS_URL}`)

const tick = async () => {
  const next = await redis.send("LPOP", [queueKey()])
  if (!next) return
  await sql`UPDATE links SET checked_by = ${who} WHERE code = ${next}`
  console.log(`checked link ${next}`)
}

setInterval(() => tick().catch((error) => console.error(`tick failed: ${error.message}`)), 500)
