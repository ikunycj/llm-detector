import { createContext, useContext } from 'react'
import type { CloudSession } from '../api'
import type { APIClient, SourceID } from '../data/sources'

export type LocationChoice = { action: 'save' | 'execute'; title: string; from?: SourceID; requireRunner?: boolean }
export type Locations = {
  clients: APIClient[]
  session?: CloudSession
  choose: (choice: LocationChoice) => Promise<APIClient | null>
  owner: (source?: SourceID) => APIClient
  ensure: (client: APIClient, runner?: boolean) => Promise<APIClient | null>
  openWorkers: () => void
  openLocal: () => void
  signIn: () => void
  signOut: () => Promise<void>
  revision: number
  changed: () => void
  label: (source?: SourceID) => string
  unavailable: (client: APIClient, reason: unknown) => void
}
export const Context = createContext<Locations | null>(null)
export function useLocations() {
  const context = useContext(Context)
  if (!context) throw new Error('缺少位置管理器')
  return context
}
