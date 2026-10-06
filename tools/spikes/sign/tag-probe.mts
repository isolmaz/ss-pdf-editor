import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const der = new Uint8Array(readFileSync(join('tools', 'spikes', 'sign', 'cms.der')));
const { fromBER } = await import('asn1js');
const contentInfo = fromBER(der).result as unknown as { valueBlock: { value: unknown[] } };
const signedData = (contentInfo.valueBlock.value[1] as { valueBlock: { value: unknown[] } }).valueBlock
  .value[0] as {
  valueBlock: { value: unknown[] };
};
const sets = signedData.valueBlock.value.filter((child) => child.constructor.name === 'Set');
const signerInfo = (sets.at(-1) as unknown as { valueBlock: { value: unknown[] } }).valueBlock.value[0] as {
  valueBlock: { value: unknown[] };
};
const attrs = signerInfo.valueBlock.value.find(
  (child) => child.constructor.name === 'Constructed',
) as unknown as {
  toBER: (flag: boolean) => ArrayBuffer;
};
console.log('as parsed, first byte:', new Uint8Array(attrs.toBER(false))[0].toString(16));
