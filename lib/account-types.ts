export type AccountUser = Readonly<{
  id: string
  username: string
  name: string
  role: "admin" | "user"
  mustChangePassword: boolean
}>

export type AdminAccountUser = AccountUser & Readonly<{
  banned: boolean
  createdAt: string
}>

export type AccountSession = { user: AccountUser | null }
export type AccountAction = "disable" | "restore" | "reset-password"
export type TemporaryPassword = { temporaryPassword: string; expiresAt: string }
export type AccountUsersPage = {
  users: AdminAccountUser[]
  total: number
  limit: number
  offset: number
}
