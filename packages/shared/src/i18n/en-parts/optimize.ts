export const optimizePart = {
  'optimize.title': 'Optimize / Compress',
  'optimize.intro':
    'Rasterizing pages loses text layers, links, annotations and bookmarks; search will not work. Preserving structure leaves content unchanged. Result file may be larger than original.',
  'optimize.mode': 'Method',
  'optimize.mode.structure': 'Preserve structure (lossless)',
  'optimize.mode.rasterize': 'Convert pages to image (lossy)',
  'optimize.imageQuality': 'Image quality',
  'optimize.qualityHint': '0.3 small file, 0.95 high quality (JPEG quality).',
  'optimize.dpi': 'Resolution (DPI)',
  'optimize.greyscale': 'Convert to greyscale',
  'optimize.stripMetadata': 'Clear metadata',
  'optimize.sourceInfo': 'Image compression source',
  'optimize.loss.rasterize':
    'Text layer, links, bookmarks and annotations convert to image; search will not work.',
  'optimize.loss.stripMetadata': 'Document metadata (Info) is deleted.',
  'optimize.producerKept': 'Producer string is preserved.',
  'optimize.done': 'Optimization completed.',
  'optimize.grew': 'Result file is larger than original; compression yielded no savings.',
  'optimize.saved': '{before} → {after} ({percent}% reduction)',
  'optimize.noGain': 'No savings: {before} → {after}',
} as const;
