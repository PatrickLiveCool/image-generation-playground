import { MAINTENANCE_COMMANDS, maintenanceError, runMaintenance, type MaintenanceCommand } from "./maintenance"

const command = process.argv[2]
if (process.argv.length !== 3 || !MAINTENANCE_COMMANDS.includes(command as MaintenanceCommand)) {
  console.error(JSON.stringify({ error: { code: "MAINTENANCE_COMMAND", message: "仅接受一个固定维护命令，不接受路径、SQL或额外参数。" } }))
  process.exitCode = 1
} else {
  runMaintenance(command as MaintenanceCommand).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(JSON.stringify(maintenanceError(error)))
    process.exitCode = 1
  })
}
