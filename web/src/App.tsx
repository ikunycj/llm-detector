import { useCallback, useState } from 'react'
import Login from './features/auth/Login'
import Workbench from './features/scans/Workbench'
import EnginesPage from './features/engines/EnginesPage'
import InspectionPage from './features/inspection/InspectionPage'
import type { AppPage } from './types'

export default function App() {
  // Refreshing the page requires login again. Neither credential is persisted.
  const [token, setToken] = useState('')
  const [notice, setNotice] = useState('')
  const [page, setPage] = useState<AppPage>('scan')
  const expired = useCallback(() => { setToken(''); setNotice('会话已失效，请重新登录。') }, [])
  return token
    ? page === 'tasks'
      ? <InspectionPage token={token} onExpired={expired} onLogout={() => { setToken(''); setNotice('') }} onNavigate={setPage} />
      : page === 'engines'
      ? <EnginesPage token={token} onExpired={expired} onLogout={() => { setToken(''); setNotice('') }} onNavigate={setPage} />
      : <Workbench token={token} onExpired={expired} onLogout={() => { setToken(''); setNotice('') }} onNavigate={setPage} />
    : <Login notice={notice} onLogin={(value) => { setNotice(''); setToken(value) }} />
}
