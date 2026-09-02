import React from 'react';
import { NotificationPanel, type NotificationPanelProps } from './NotificationPanel';

export type NotificationCenterProps = NotificationPanelProps;

export const NotificationCenter: React.FC<NotificationCenterProps> = (props) => {
  return <NotificationPanel {...props} />;
};

export default NotificationCenter;
