import { createInterface } from "node:readline/promises"
import { pathToFileURL } from "node:url"
import { stdin, stdout } from "node:process"
import { bootstrapAdministrator } from "../../lib/auth/accounts"
import { AccountError } from "../../lib/auth/errors"
import { closeDatabase } from "../../lib/database"

async function hiddenPassword(): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("Use a protected BOOTSTRAP_ADMIN_PASSWORD environment injection or an interactive terminal")
  stdout.write("管理员密码（12–128 字符，不回显）: ")
  const previousRaw = stdin.isRaw
  stdin.setRawMode(true)
  stdin.resume()
  return new Promise((resolve, reject) => {
    let password = ""
    const cleanup = () => {
      stdin.off("data", onData)
      stdin.setRawMode(previousRaw)
      stdin.pause()
      stdout.write("\n")
    }
    const onData = (buffer: Buffer) => {
      for (const character of buffer.toString("utf8")) {
        if (character === "\u0003" || character === "\u0004") { cleanup(); reject(new Error("Cancelled")); return }
        if (character === "\r" || character === "\n") { cleanup(); resolve(password); return }
        if (character === "\u007f" || character === "\b") password = password.slice(0, -1)
        else if (character >= " " && password.length < 129) password += character
      }
    }
    stdin.on("data", onData)
  })
}

export async function runBootstrapAdmin() {
  if (process.argv.length > 2) throw new Error("Command-line credential arguments are not accepted")
  let username = process.env.BOOTSTRAP_ADMIN_USERNAME
  let name = process.env.BOOTSTRAP_ADMIN_NAME
  let password = process.env.BOOTSTRAP_ADMIN_PASSWORD
  delete process.env.BOOTSTRAP_ADMIN_PASSWORD
  if ((!username || !name) && stdin.isTTY) {
    const prompt = createInterface({ input: stdin, output: stdout })
    try {
      username ||= await prompt.question("管理员用户名: ")
      name ||= await prompt.question("管理员姓名: ")
    } finally { prompt.close() }
  }
  password ||= await hiddenPassword()
  // Uses the verified runtime identity: initialization needs DML only. The
  // runtime never receives migration/cloud credentials for this operation.
  await bootstrapAdministrator({ username, name, password })
  password = undefined
  stdout.write("首位管理员已初始化。请使用所输入的密码登录。\n")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBootstrapAdmin().catch((error: unknown) => {
    console.error(error instanceof AccountError ? error.message : "初始化失败。请检查受限环境配置和本地维护入口。")
    process.exitCode = 1
  }).finally(() => closeDatabase())
}
