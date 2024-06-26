import { resolve } from 'path';
import { writeFile } from 'fs/promises';
import { runTypeChain } from 'typechain';
import { promise as glob } from 'glob-promise';
import { abi as previewerABI } from '@exactly/protocol/deployments/ethereum/Previewer.json';
import { abi as marketABI } from '@exactly/protocol/deployments/ethereum/MarketWETH.json';

Promise.all([
  writeFile(resolve(__dirname, '../actions/abi/Previewer.json'), JSON.stringify(previewerABI, null, 2)),
  writeFile(resolve(__dirname, '../actions/abi/Market.json'), JSON.stringify(marketABI, null, 2)),
]).then(() => glob(resolve(__dirname, '../actions/abi/*.json'))).then((allFiles) => runTypeChain({
  cwd: resolve(__dirname, '../actions'),
  filesToProcess: allFiles,
  target: 'ethers-v5',
  outDir: 'types',
  allFiles,
})).catch((error) => { throw error; });
