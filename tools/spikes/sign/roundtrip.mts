import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromBER } from 'asn1js';

const der = new Uint8Array(readFileSync(join('tools', 'spikes', 'sign', 'openssl-cms.der')));
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
  valueBlock: { value: unknown[] };
};
console.log('attributes OpenSSL wrote, re-encoded by asn1js:', new Uint8Array(attrs.toBER(false)).length);
for (const [index, attr] of attrs.valueBlock.value.entries()) {
  const child = attr as unknown as { valueBlock: { value: unknown[] }; toBER: (f: boolean) => ArrayBuffer };
  const first = child.valueBlock.value[0] as unknown as { valueBlock: { value: string } };
  console.log(
    index,
    'attribute',
    first.valueBlock?.value ?? '?',
    new Uint8Array(child.toBER(false)).length,
    Buffer.from(child.toBER(false)).toString('hex').slice(0, 40),
  );
}
