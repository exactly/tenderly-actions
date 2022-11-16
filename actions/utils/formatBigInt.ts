export type Unit = number | string;

export default (
  n: bigint | string,
  symbol: Unit = 18,
  decimals = { Ξ: 18, gwei: 9 }[symbol] ?? Number(symbol),
  maximumFractionDigits = {
    Ξ: 4, gwei: 1, WETH: 4, DAI: 2, USDC: 2, WBTC: 5, wstETH: 4,
  }[symbol] ?? decimals,
) => `${
  (Number(n) / 10 ** decimals).toLocaleString(undefined, { maximumFractionDigits })
}${typeof symbol === 'string' ? ` ${symbol}` : ''}`;
