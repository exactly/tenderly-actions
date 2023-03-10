import type { BigNumberish } from '@ethersproject/bignumber';

export type Unit = number | string;

export default (
  n: BigNumberish,
  symbol: Unit = 18,
  decimals = {
    Ξ: 18, gwei: 9, $: 18, '%': 18,
  }[symbol] ?? Number(symbol),
  maximumFractionDigits = {
    Ξ: 5, gwei: 2, $: 2, '%': 2, WETH: 5, DAI: 2, USDC: 2, WBTC: 5, wstETH: 5, OP: 2,
  }[symbol] ?? decimals,
) => `${(Number(n) / 10 ** decimals).toLocaleString(undefined, {
  ...symbol === '$' && { style: 'currency', currency: 'USD' },
  ...symbol === '%' && { style: 'percent' },
  maximumFractionDigits,
})}${typeof symbol === 'string' && !['$', '%'].includes(symbol) ? ` ${symbol}` : ''}`;
