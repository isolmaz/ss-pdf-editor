import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromBER } from 'asn1js';

const dir = join('tools', 'spikes', 'sign');
const der = new Uint8Array(readFileSync(join(dir, 'cms.der')));
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
writeFileSync(join(dir, 'attrs-from-cms.bin'), new Uint8Array(attrs.toBER(false)));
console.log('extracted', new Uint8Array(attrs.toBER(false)).length);
