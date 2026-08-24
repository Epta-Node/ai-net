// src/components/dashboard/DashboardLayout.tsx
import React, { ReactNode } from 'react';
import styles from './DashboardLayout.module.css';

interface Props {
  children: ReactNode;
  className?: string;
}

export const DashboardLayout: React.FC<Props> = ({ children, className }) => {
  return <section className={[styles.container, className].filter(Boolean).join(' ')}>{children}</section>;
};
