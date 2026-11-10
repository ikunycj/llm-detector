import { useCallback, useState } from 'react'
import Login from './features/auth/Login'
import Workbench from './features/scans/Workbench'

export default function App() {
  // Refreshing the page requires login again. Neither credential is persisted.
  const [token, setToken] = useState('')
  const [notice, setNotice] = useState('')
  const expired = useCallback(() => { setToken(''); setNotice('会话已失效，请重新登录。') }, [])
  return token
    ? <Workbench token={token} onExpired={expired} onLogout={() => { setToken(''); setNotice('') }} />
    : <Login notice={notice} onLogin={(value) => { setNotice(''); setToken(value) }} />
}
