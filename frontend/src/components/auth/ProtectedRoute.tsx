/**
 * ProtectedRoute — Route guard for wallet-authenticated pages.
 *
 * Wraps any route that requires a connected Stellar wallet. Unauthenticated
 * visitors are redirected to `redirectTo` (default: "/") and the attempted
 * path is stored in `location.state.from` so the landing page can send the
 * user back after they connect.
 *
 * ## Usage
 *
 * ```tsx
 * // Wrap a single route
 * <Route path="/dashboard" element={
 *   <ProtectedRoute><DashboardPage /></ProtectedRoute>
 * } />
 *
 * // Custom redirect destination
 * <Route path="/admin" element={
 *   <ProtectedRoute redirectTo="/connect"><AdminPage /></ProtectedRoute>
 * } />
 * ```
 *
 * ## Redirect-back after connect
 *
 * The landing page (or any connect flow) can read `location.state.from` and
 * navigate back automatically after the wallet is connected:
 *
 * ```tsx
 * const location = useLocation();
 * const from: string = location.state?.from?.pathname ?? '/dashboard';
 *
 * useEffect(() => {
 *   if (connected) navigate(from, { replace: true });
 * }, [connected]);
 * ```
 *
 * ## Why `<Navigate replace>` instead of `window.location`
 *
 * `window.location.replace()` triggers a full browser navigation, destroying
 * the React component tree and all in-memory state. `<Navigate replace>` is a
 * client-side redirect that preserves the React context tree, avoids a network
 * round-trip, and keeps the browser history clean (no extra back-stack entry).
 */

import React from 'react';
import { useAuthGuard, type UseAuthGuardOptions } from '../../hooks/useAuthGuard.tsx';

export interface ProtectedRouteProps extends UseAuthGuardOptions {
  /** The page component to render when the user is authenticated. */
  children: React.ReactNode;
  /**
   * Optional fallback rendered while the auth state is being determined.
   * In practice, `WalletContext` resolves synchronously from `localStorage`
   * so this is rarely visible. Defaults to `null` (render nothing).
   */
  fallback?: React.ReactNode;
}

/**
 * Route guard component — renders `children` when the wallet is connected,
 * or issues a client-side redirect otherwise.
 */
export function ProtectedRoute({
  children,
  redirectTo = '/',
  fallback = null,
}: ProtectedRouteProps): React.ReactElement | null {
  const { connected, redirect } = useAuthGuard({ redirectTo });

  // Unauthenticated: redirect to the landing / connect page.
  if (redirect) {
    return redirect;
  }

  // Connected but wallet context not yet confirmed (edge case on first paint).
  if (!connected) {
    return <>{fallback}</>;
  }

  return <>{children}</>;
}

// Assign a display name so the component appears clearly in React DevTools
// and in test failure messages.
ProtectedRoute.displayName = 'ProtectedRoute';
