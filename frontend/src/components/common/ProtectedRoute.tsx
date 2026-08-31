import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useWallet } from '../../context/WalletContext';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { connected } = useWallet();
  const location = useLocation();

  if (!connected) {
    return <Navigate to="/" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}
