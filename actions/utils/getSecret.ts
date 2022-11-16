import type { Secrets } from '@tenderly/actions';

export default async (secrets: Secrets, key: string) => {
  try { return await secrets.get(key); } catch { return undefined; }
};
