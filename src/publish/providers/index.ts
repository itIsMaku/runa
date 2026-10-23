import type { TunnelProvider } from '../types.js';
import { cloudflare } from './cloudflare.js';

export const tunnelProviders: readonly TunnelProvider[] = [cloudflare];

export function findTunnelProvider(id = 'cloudflare'): TunnelProvider {
  const provider = tunnelProviders.find((item) => item.id === id);
  if (!provider) {
    throw new Error(
      `Unknown tunnel provider "${id}". Available: ${tunnelProviders.map((item) => item.id).join(', ')}.`,
    );
  }
  return provider;
}
