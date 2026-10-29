import { readdirSync } from "node:fs"
import { spawnSync } from "node:child_process"

// PostgreSQL suites have an explicit entrypoint; default tests need no services.
const files = readdirSync(new URL("../tests/", import.meta.url))
  .filter(name => /\.test\.tsx?$/.test(name) && !/-integration\.test\.tsx?$/.test(name))
  .sort().map(name => `tests/${name}`)
if (!files.length) throw new Error("No application tests found")
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], { stdio: "inherit" })
if (result.error) throw result.error
process.exit(result.status ?? 1)
