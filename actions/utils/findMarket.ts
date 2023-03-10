import type { Previewer } from '../types/Previewer';

export default (
  exactly: Previewer.MarketAccountStructOutput[],
  addressOrPredicate: string | ((market: Previewer.MarketAccountStructOutput) => boolean),
) => exactly.find(typeof addressOrPredicate === 'function' ? addressOrPredicate
  : ({ market }) => market.toLowerCase() === addressOrPredicate.toLowerCase());
