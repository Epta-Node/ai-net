/**
 * useAuthGuard — Centralised authentication redirect hook.
 *
 * Encapsulates the "is the wallet connected?" check used by both
 * `ProtectedRoute` and any imperative code (e.g. a button handler) that
 * needs to bounce unauthenticated users to the landing page.
 *
 * ## Redirect-back
 * When `redirectTo` is set (default: "/") the hook passes the current
 * location as `state.from` on the `<Navigate>` element so the landing page
 * can deep-link the user back after they connect their wallet:
 *
 * ```tsx
 * // LandingPage.tsx (after connect)
 * const location = useLocation();
 * const from = location.state?.from?.pathname ?? '/dashboard';
 * navigate(from, { replace: true });
 * ```
 *
 * ## WalletContext initialisation window
 * `WalletContext` reads `localStorage` synchronously on mount, so `connected`
 * is already correct on the first render — there is no async "loading" phase
 * to wait for. The `ready` flag (returned for convenience) does reflect an
 * async state: it is `false` when the user connected via secret key in a
 * previous session but the in-memory keypair has been lost on page refresh.
 *
 * @param redirectTo  Path to redirect unauthenticated users to. Defaults to "/".
 * @returns           Auth state and a JSX redirect element when unauthenticated.
 */

import { useLocation, Navigate } from 'react-router-dom';
import { useWallet } from '../context/WalletContext';

export interface UseAuthGuardOptions {
  /** Destination for unauthenticated users. Defaults to `"/"`. */
  redirectTo?: string;
}

export interface UseAuthGuardResult {
  /** True when a wallet is connected (public key present in context). */
  connected: boolean;
  /**
   * True when the wallet can sign transactions:
   * - Freighter: always ready when connected.
   * - Secret key: only ready when the keypair is still in memory.
   */
  ready: boolean;
  /** The connected wallet's public key, or `null` when disconnected. */
  publicKey: string | null;
  /**
   * When the user is **not** connected, this is a `<Navigate>` element that
   * should be returned directly from the component render function.
   * When connected, this is `null`.
   *
   * ```tsx
   * const { redirect } = useAuthGuard();
   * if (redirect) return redirect;
   * ```
   */
  redirect: React.ReactElement | null;
}

export function useAuthGuard({
  redirectTo = '/',
}: UseAuthGuardOptions = {}): UseAuthGuardResult {
  const { connected, ready, publicKey } = useWallet();
  const location = useLocation();

  const redirect =
    !connected ? (
      <Navigate
        to={redirectTo}
        replace
        // Carry the attempted path so the landing page can redirect back
        // after the user connects their wallet.
        state={{ from: location }}
      />
    ) : null;

  return { connected, ready, publicKey, redirect };
}
