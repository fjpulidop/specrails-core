import { Routes, Route, Navigate } from 'react-router-dom'
import { RootLayout } from './components/RootLayout'
import DashboardPage from './pages/DashboardPage'
import SettingsPage from './pages/SettingsPage'
import AnalyticsPage from './pages/AnalyticsPage'
import { SharedWebSocketProvider } from './hooks/useSharedWebSocket'
import { WS_URL } from './lib/ws-url'

export default function App() {
  return (
    <SharedWebSocketProvider url={WS_URL}>
      <Routes>
        <Route element={<RootLayout />}>
          <Route index element={<DashboardPage />} />
          <Route path="/jobs/:id" element={<DashboardPage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </SharedWebSocketProvider>
  )
}
