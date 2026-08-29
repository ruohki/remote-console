import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router'
import { AuthProvider, useAuth } from '@/store/auth'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Layout } from '@/components/Layout'
import { Toaster } from '@/lib/toast'
import { ApiError } from '@/lib/api'
import { Login } from '@/pages/Login'
import { Setup } from '@/pages/Setup'
import { ForgotPassword } from '@/pages/ForgotPassword'
import { ResetPassword } from '@/pages/ResetPassword'
import { Devices } from '@/pages/Devices'
import { DeviceDetail } from '@/pages/DeviceDetail'
import { Viewer } from '@/pages/Viewer'
import { Sessions } from '@/pages/Sessions'
import { UsersPage } from '@/pages/Users'
import { Audit } from '@/pages/Audit'
import { Settings } from '@/pages/Settings'
import { GroupsPage } from '@/pages/Groups'
import { GroupDetail } from '@/pages/GroupDetail'
import { NotFound } from '@/pages/NotFound'
import { SecurityPage } from '@/pages/Security'
import { SecuritySetup } from '@/pages/SecuritySetup'
import { allowedWhileEnrollmentPending } from '@/lib/authFlow'
import { Skeleton } from '@/components/ui'
import { useApplyBranding } from '@/lib/branding'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      staleTime: 10_000,
      refetchOnWindowFocus: false,
    },
  },
})

/** Loads the public branding once and keeps the document title / accent in sync. */
function BrandingBoot() {
  useApplyBranding()
  return null
}

function RequireAuth({ admin }: { admin?: boolean }) {
  const { user, needsSetup } = useAuth()
  const location = useLocation()
  if (user === undefined || needsSetup === undefined) {
    return (
      <div className="p-6">
        <Skeleton className="mb-3 h-6 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }
  if (needsSetup) return <Navigate to="/setup" replace />
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  // 2FA policy: nothing else works until the second factor is enrolled.
  if (user.two_factor_required && !allowedWhileEnrollmentPending(location.pathname)) return <Navigate to="/security/setup" replace />
  if (admin && user.role !== 'admin') return <NotFound />
  return <Outlet />
}

export default function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            <BrandingBoot />
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/setup" element={<Setup />} />
              <Route path="/forgot-password" element={<ForgotPassword />} />
              <Route path="/reset-password" element={<ResetPassword />} />
              <Route element={<RequireAuth />}>
                {/* forced second-factor enrollment (no chrome, cannot be left) */}
                <Route path="/security/setup" element={<SecuritySetup />} />
                {/* the viewer takes the whole viewport, no chrome */}
                <Route path="/viewer/:deviceId" element={<Viewer />} />
                <Route element={<Layout />}>
                  <Route index element={<Navigate to="/devices" replace />} />
                  <Route path="/devices" element={<Devices />} />
                  <Route path="/devices/:id" element={<DeviceDetail />} />
                  <Route path="/sessions" element={<Sessions />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="/settings/tokens" element={<Settings tab="tokens" />} />
                  <Route path="/settings/branding" element={<Settings tab="branding" />} />
                  <Route path="/settings/agent" element={<Settings tab="agent" />} />
                  <Route path="/settings/auth" element={<Settings tab="auth" />} />
                  <Route path="/settings/email" element={<Settings tab="email" />} />
                  <Route path="/security" element={<SecurityPage />} />
                  <Route element={<RequireAuth admin />}>
                    <Route path="/groups" element={<GroupsPage />} />
                    <Route path="/groups/:id" element={<GroupDetail />} />
                    <Route path="/users" element={<UsersPage />} />
                    <Route path="/audit" element={<Audit />} />
                  </Route>
                  <Route path="*" element={<NotFound />} />
                </Route>
              </Route>
            </Routes>
            <Toaster />
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  )
}
