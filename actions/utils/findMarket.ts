import type { Previewer } from '../types/Previewer';

export default (exactly: Previewer.MarketAccountStructOutput[], address: string) => exactly
  .find(({ market }) => market.toLowerCase() === address.toLowerCase());
