import { Routes, Route, Navigate } from 'react-router-dom'
import { RootLayout } from './components/RootLayout'
import DashboardPage from './pages/DashboardPage'
import SettingsPage from './pages/SettingsPage'

export default function App() {
  return (
    <Routes>
      <Route element={<RootLayout />}>
        <Route index element={<DashboardPage />} />
        <Route path="/jobs/:id" element={<DashboardPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
