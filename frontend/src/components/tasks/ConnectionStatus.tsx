import { useTranslation } from 'react-i18next';
import type { WebSocketStatus } from '../../hooks/useTaskWebSocket';

interface ConnectionStatusProps {
  status: WebSocketStatus;
  /** Milliseconds until the next automatic reconnect, 0 when none is scheduled. */
  reconnectIn: number;
}

const TONES = {
  connecting: 'var(--status-info-text, #3b82f6)',
  reconnecting: 'var(--status-warning-text, #f97316)',
  disconnected: 'var(--status-error-text, #ef4444)',
};

/** Banner shown while the live task stream is not connected (#827). Hidden once connected. */
export function ConnectionStatus({ status, reconnectIn }: ConnectionStatusProps) {
  const { t } = useTranslation();

  if (status === 'connected' || status === 'authentication-required') return null;

  const tone = status === 'connecting' ? 'connecting' : reconnectIn > 0 ? 'reconnecting' : 'disconnected';
  const message =
    tone === 'connecting'
      ? t('page.task.ws.banner.connecting', { defaultValue: 'Connecting…' })
      : tone === 'reconnecting'
        ? t('page.task.ws.banner.reconnecting', {
            defaultValue: 'Reconnecting in {{seconds}}s…',
            seconds: Math.ceil(reconnectIn / 1000),
          })
        : t('page.task.ws.banner.disconnected', {
            defaultValue: 'Disconnected. Refresh to reconnect.',
          });

  return (
    <div
      role="status"
      data-connection-state={tone}
      className="rounded-md border px-3 py-2 text-xs"
      style={{ borderColor: TONES[tone], color: TONES[tone] }}
    >
      {message}
    </div>
  );
}
