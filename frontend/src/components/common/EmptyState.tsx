import React, { useContext } from 'react';
import { useNavigate, UNSAFE_NavigationContext } from 'react-router-dom';
import styles from './EmptyState.module.css';

export interface EmptyStateAction {
  label: string;
  onClick?: () => void;
  to?: string;
  icon?: React.ReactNode;
}

export interface EmptyStateProps {
  title: string;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  primaryAction?: EmptyStateAction;
  secondaryAction?: EmptyStateAction;
  variant?: 'default' | 'card' | 'compact';
  className?: string;
  'data-testid'?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  title,
  description,
  icon,
  primaryAction,
  secondaryAction,
  variant = 'default',
  className = '',
  'data-testid': dataTestId = 'empty-state',
}) => {
  const navigationContext = useContext(UNSAFE_NavigationContext);
  let navigate: ReturnType<typeof useNavigate> | null = null;
  if (navigationContext) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    navigate = useNavigate();
  }

  const handleActionClick = (action: EmptyStateAction, e: React.MouseEvent) => {
    if (action.onClick) {
      action.onClick();
    }
    if (action.to) {
      e.preventDefault();
      if (navigate) {
        navigate(action.to);
      } else {
        window.location.href = action.to;
      }
    }
  };

  const variantClass =
    variant === 'card'
      ? styles.cardVariant
      : variant === 'compact'
      ? styles.compactVariant
      : '';

  return (
    <div
      className={`${styles.container} ${variantClass} ${className}`.trim()}
      data-testid={dataTestId}
    >
      {icon && (
        <div className={styles.iconWrapper} aria-hidden="true">
          <div className={styles.iconGlow} />
          <div className={styles.iconContent}>{icon}</div>
        </div>
      )}

      <h3 className={styles.title}>{title}</h3>

      {description && (
        <div className={styles.description}>
          {typeof description === 'string' ? <p>{description}</p> : description}
        </div>
      )}

      {(primaryAction || secondaryAction) && (
        <div className={styles.actions}>
          {primaryAction && (
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={(e) => handleActionClick(primaryAction, e)}
              data-testid="empty-state-primary-cta"
            >
              {primaryAction.icon && <span aria-hidden="true">{primaryAction.icon}</span>}
              <span>{primaryAction.label}</span>
            </button>
          )}

          {secondaryAction && (
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={(e) => handleActionClick(secondaryAction, e)}
              data-testid="empty-state-secondary-cta"
            >
              {secondaryAction.icon && <span aria-hidden="true">{secondaryAction.icon}</span>}
              <span>{secondaryAction.label}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default EmptyState;
