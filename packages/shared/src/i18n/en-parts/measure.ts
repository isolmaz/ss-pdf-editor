export const measurePart = {
  'tools.measure': 'Measure',
  'tools.measure.distance': 'Distance',
  'tools.measure.perimeter': 'Perimeter',
  'tools.measure.area': 'Area',
  'tools.measure.scale': 'Scale',
  'tools.measure.scaleHint': 'e.g. 1:100 · 1 cm = 5 m',
  'tools.measure.scaleUnreadable': 'Could not parse scale ratio; previous scale remains active.',
  'tools.measure.unit': 'Unit',
  'tools.measure.grid': 'Grid',
  'tools.measure.gridGap': 'Spacing',
  'tools.measure.snapGrid': 'Snap to grid',
  'tools.measure.snapPoints': 'Snap to endpoints',
  'tools.measure.selfIntersecting':
    "The polygon's edges cross each other, so its area cannot be measured. Place the points so that no edges cross.",
  'op.progress.measure': 'Writing measurements',
  'op.note.measure.written': '{count} measurement annotation(s) written with /Measure dictionary.',
  'op.note.measure.readers':
    'The /Measure dictionary is written in the ISO 32000-1 form (/RL subtype with /X, /D and /A number format arrays). Readers without measurement support show only the line and the comment text.',
  'op.note.measure.nothing': 'No measurements to write; document untouched.',
} as const;
