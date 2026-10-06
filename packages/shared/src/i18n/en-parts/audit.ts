export const auditPart = {
  'audit.title': 'Redaction audit',
  'audit.findings': 'Audit findings',
  'audit.summary': 'File contains {objects} object(s) across {revisions} revision(s); size is {bytes}.',
  'audit.rerun': 'Rerun audit',
  'audit.empty': 'No audit report yet. Results appear here after auditing a redacted document.',
  'audit.loading': 'Preparing audit report…',
  'audit.group.content': 'Content',
  'audit.group.warning': 'Warning',
  'audit.group.info': 'Information',
  'audit.residual': 'Search term #{term} found in raw byte stream at {count} location(s).',
  'audit.clean.text': 'None of the {terms} searched terms were found in raw bytes.',
  'audit.clean.textRest': 'Remaining {terms} searched term(s) not found in raw bytes.',
  'audit.revision':
    'File contains {revisions} revision(s); {chains} linked to earlier version via /Prev chain.',
  'audit.clean.revisions': 'File has a single revision; no prior version links.',
  'audit.orphan': 'File contains {count} unreferenced object definition(s).',
  'audit.clean.orphans': 'No unreferenced object definitions found.',
  'audit.orphans.skipped':
    'File contains {streams} object stream(s) (/ObjStm); orphan check skipped because cross-reference graph cannot be fully inspected from raw bytes.',
  'audit.compressed':
    'File contains {count} compressed stream(s) (FlateDecode); scanner does not decompress these streams.',
  'audit.clean.compressed': 'No compressed streams; scanner inspected all raw bytes.',
  'audit.metadata': 'Info metadata present in file ({count} entry(ies)).',
  'audit.clean.metadata': 'No Info metadata present.',
  'audit.xmp': 'XMP metadata packet present in file ({count} packet(s)).',
  'audit.clean.xmp': 'No XMP metadata present.',
  'audit.attachment': 'File contains {count} embedded attachment(s).',
  'audit.clean.attachments': 'No embedded file attachments found.',
  'audit.annotation': 'File contains {count} annotation array (/Annots) record(s); arrays may be empty.',
  'audit.clean.annotations': 'No annotation array (/Annots) records found.',
  'audit.javascript': 'File contains {count} JavaScript action(s).',
  'audit.clean.javascript': 'No JavaScript actions found.',
  'audit.names': 'File contains name tree (/Names) record(s) ({count}).',
  'audit.clean.names': 'No name tree (/Names) records found.',

  /* The notice the audit ends on: what the scan covered, and what it found (`R06`). */
  'audit.notice.terms': 'The redaction audit ran against {count} term(s); the result is in the panel.',
  'audit.notice.residual':
    'The redaction audit reported {count} finding(s): erased text may still be in the file. The result is in the panel.',
  'op.progress.redact.find': 'Searching text',
} as const;
