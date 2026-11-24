import { Suspense } from 'react';
import { TaskSubmissionForm } from '../../components/agents/TaskSubmissionForm';
import { Skeleton, SkeletonCard, SkeletonText } from '../../components/common/Skeleton';

/**
 * Context-aware skeleton that mirrors the TaskSubmissionForm layout so there
 * is no layout shift while the form component loads.
 */
export function NewTaskPageSkeleton() {
  return (
    <div
      data-testid="new-task-skeleton"
      aria-busy="true"
      aria-label="Loading new task form"
      style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: '640px' }}
    >
      {/* Title */}
      <Skeleton width="12rem" height="1.75rem" />

      {/* Prompt textarea */}
      <SkeletonCard>
        <Skeleton width="6rem" height="0.75rem" style={{ marginBottom: '0.75rem' }} />
        <Skeleton variant="rectangular" width="100%" height="7rem" />
      </SkeletonCard>

      {/* Budget field */}
      <SkeletonCard>
        <Skeleton width="8rem" height="0.75rem" style={{ marginBottom: '0.75rem' }} />
        <Skeleton width="60%" height="2.5rem" />
      </SkeletonCard>

      {/* Agent preferences */}
      <SkeletonCard>
        <Skeleton width="10rem" height="0.75rem" style={{ marginBottom: '0.75rem' }} />
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {['Research', 'Risk', 'Coding', 'Design', 'Report'].map((label) => (
            <Skeleton key={label} variant="pill" width="5.5rem" height="2rem" />
          ))}
        </div>
      </SkeletonCard>

      {/* DAG preview placeholder */}
      <SkeletonCard>
        <SkeletonText lines={2} />
      </SkeletonCard>

      {/* Submit button */}
      <Skeleton variant="pill" width="10rem" height="2.75rem" />
    </div>
  );
}

export default function NewTaskPage() {
  return (
    <Suspense fallback={<NewTaskPageSkeleton />}>
      <TaskSubmissionForm />
    </Suspense>
  );
}
