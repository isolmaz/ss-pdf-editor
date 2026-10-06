export const verifyPart = {
  'verify.fact.pageCount': 'page count',
  'verify.fact.pageOrder': 'page order',
  'verify.fact.pageContent': 'page content',
  'verify.fact.formFieldCount': 'form field count',
  'verify.fact.formFieldValues': 'form field values',
  'verify.fact.annotations': 'annotations',
  'verify.fact.outlines': 'outline',
  'verify.fact.pageLabels': 'page labels',
  'verify.fact.textContent': 'text',
  'verify.fact.rotation': 'rotation',
  'verify.fact.cropBox': 'crop box',
  'verify.fact.signatures': 'signatures',

  'verify.verified': 'Verified: {facts}.',
  'verify.degraded': 'Partly verified: {facts}.',
  'verify.unsupported': 'Not checked by this build: {facts}.',
  'verify.declared': 'The operation may change: {facts}.',

  'verify.reason.budget': 'over the memory budget',
  'verify.reason.sampled': '{count} page(s) sampled',
  'verify.reason.changed': 'the operation may change it',
  'verify.reason.unverified': 'unrecognised operation: {steps}',
  'verify.reason.no-reference': 'nothing to compare against',
  'verify.reason.engine-cannot': 'the reader cannot answer this',
  'verify.reason.pending-storage': "the engine's pending annotation storage overlaps the reference",
  'verify.reason.trust-policy':
    'signature validity needs the trust policy, which the save path checks separately',
} as const;
