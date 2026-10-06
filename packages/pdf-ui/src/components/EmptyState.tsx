import { Empty } from '@cloudflare/kumo/components/empty';
import type { ReactNode } from 'react';

export interface EmptyStateProps {
  readonly title: string;
  readonly description?: string;
  readonly icon?: ReactNode;
  /** Primary action(s) rendered under the description. */
  readonly action?: ReactNode;
}

/** Empty states are product surface, not leftovers (`K25`; first run matters). */
export function EmptyState({ title, description, icon, action }: EmptyStateProps) {
  return (
    <Empty
      {...(icon === undefined ? {} : { icon })}
      title={title}
      {...(description === undefined ? {} : { description })}
      {...(action === undefined ? {} : { contents: action })}
    />
  );
}
