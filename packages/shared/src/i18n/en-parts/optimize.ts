export const optimizePart = {
  'optimize.title': 'Reduce file size',
  'optimize.intro':
    'Rasterizing removes text, links, annotations and bookmarks, so search stops working. Keeping the structure leaves content unchanged. The file can grow.',
  'optimize.mode': 'Method',
  'optimize.mode.structure': 'Preserve structure (lossless)',
  'optimize.mode.rasterize': 'Convert pages to image (lossy)',
  'optimize.imageQuality': 'Image quality',
  'optimize.qualityHint': '0.3 small file, 0.95 high quality (JPEG quality).',
  'optimize.dpi': 'Resolution (DPI)',
  'optimize.greyscale': 'Convert to greyscale',
  'optimize.stripMetadata': 'Clear metadata',
  'optimize.producerKept': 'Producer string is preserved.',
  'optimize.grew': 'Result file is larger than original; compression yielded no savings.',
  'optimize.saved': '{before:bytes} → {after:bytes} ({percent}% reduction)',
  'optimize.noGain': 'No savings: {before:bytes} → {after:bytes}',
} as const;
