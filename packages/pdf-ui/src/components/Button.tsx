import { type ButtonProps, Button as KumoButton } from '@cloudflare/kumo/components/button';

/**
 * Kumo `Button` wrapped for our density and semantics (`K24`).
 *
 * Application code imports this, never `@cloudflare/kumo` directly. A dense
 * professional tool defaults to the small size and the secondary variant; a
 * caller that wants emphasis asks for it explicitly.
 */
export type AppButtonProps = ButtonProps;

export function Button(props: AppButtonProps) {
  return <KumoButton size="sm" variant="secondary" {...props} />;
}
