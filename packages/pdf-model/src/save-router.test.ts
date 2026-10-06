import { describe, expect, it } from 'vitest';
import { type ChangeSummary, NO_CHANGES, planSave, type SavePathId } from './save-router';

/**
 * Save routing + dependency order. The router decides
 * *which* paths run and in which order; these tests pin the decisions that cost
 * data when they are wrong (incremental fast path, metadata after a rewrite,
 * protection never silently dropped, signature last).
 */

const changes = (patch: Partial<ChangeSummary>): ChangeSummary => ({ ...NO_CHANGES, ...patch });
const ids = (paths: readonly SavePathId[]): SavePathId[] => [...paths];

describe('planSave', () => {
  it('plans nothing for an unchanged session', () => {
    const plan = planSave(NO_CHANGES);
    expect(ids(plan.paths)).toEqual(['no-op']);
    expect(plan.steps).toHaveLength(0);
    expect(plan.incremental).toBe(true);
    expect(plan.rewritesStructure).toBe(false);
  });

  it('keeps a pure annotation change on the incremental fast path', () => {
    const plan = planSave(changes({ annotations: true }));
    expect(ids(plan.paths)).toEqual(['pdfjs-save-document']);
    expect(plan.incremental).toBe(true);
    expect(plan.rewritesStructure).toBe(false);
  });

  it('routes page edits through page composition instead of saveDocument', () => {
    const plan = planSave(changes({ pageOrder: true }));
    expect(ids(plan.paths)).toEqual(['pdfjs-extract-pages']);
    expect(plan.incremental).toBe(false);
    expect(plan.steps[0]?.engine).toBe('pdfjs');
  });

  it('makes redaction a full rewrite and puts metadata after it', () => {
    const plan = planSave(changes({ redaction: true }));
    const order = plan.steps.map((step) => step.id);
    expect(order[0]).toBe('mupdf-rewrite');
    expect(order.indexOf('metadata-write')).toBeGreaterThan(order.indexOf('mupdf-rewrite'));
    expect(plan.incremental).toBe(false);
    expect(plan.rewritesStructure).toBe(true);
  });

  it('runs writer steps before the metadata step for overlays', () => {
    const plan = planSave(changes({ overlays: true, metadata: true }));
    const order = plan.steps.map((step) => step.id);
    expect(order).toEqual(['writer-steps', 'metadata-write']);
    expect(plan.steps[0]?.engine).toBe('mupdf');
  });

  it('decrypts an encrypted input before plain-bytes engines and re-protects afterwards', () => {
    const plan = planSave(changes({ overlays: true }), { encryptedInput: true });
    const order = plan.steps.map((step) => step.id);
    expect(order[0]).toBe('decrypt-input');
    expect(order).toContain('qpdf-encrypt');
    expect(order.indexOf('qpdf-encrypt')).toBeGreaterThan(order.indexOf('writer-steps'));
    expect(plan.decryptsInput).toBe(true);
    expect(plan.reprotects).toBe(true);
    expect(plan.incremental).toBe(false);
  });

  it('re-protects an encrypted input even when only annotations changed', () => {
    const plan = planSave(changes({ annotations: true }), { encryptedInput: true });
    const order = plan.steps.map((step) => step.id);
    expect(order).toEqual(['pdfjs-save-document', 'qpdf-encrypt']);
    expect(plan.decryptsInput).toBe(false);
    expect(plan.reprotects).toBe(true);
    expect(plan.incremental).toBe(false);
  });

  it('does not re-protect when the user asked to remove protection', () => {
    const plan = planSave(changes({ overlays: true }), { encryptedInput: true, removeProtection: true });
    expect(plan.reprotects).toBe(false);
    expect(plan.steps.map((step) => step.id)).not.toContain('qpdf-encrypt');
  });

  it('finalises a signature after content and encryption', () => {
    const plan = planSave(changes({ overlays: true, metadata: true, encryption: true, signature: true }));
    const order = plan.steps.map((step) => step.id);
    expect(order[order.length - 1]).toBe('signature-finalize');
    expect(order).toEqual(['writer-steps', 'metadata-write', 'qpdf-encrypt', 'signature-finalize']);
    expect(plan.steps[order.indexOf('signature-finalize')]?.engine).toBe('signature');
  });

  it('reports a full-size rewrite whenever a writer touches the document', () => {
    expect(planSave(changes({ boxes: true })).rewritesStructure).toBe(true);
    expect(planSave(changes({ metadata: true })).rewritesStructure).toBe(false);
    expect(planSave(changes({ metadata: true })).incremental).toBe(false);
  });

  it('keeps a form-value change on the pdf.js incremental fast path', () => {
    const plan = planSave(changes({ forms: true }));
    expect(ids(plan.paths)).toEqual(['pdfjs-save-document']);
    expect(plan.incremental).toBe(true);
  });

  it('sends layer and widget writes through the writer steps, like boxes and overlays', () => {
    for (const patch of [{ layers: true }, { widgets: true }, { boxes: true }, { overlays: true }]) {
      const plan = planSave(changes(patch));
      expect(ids(plan.paths), JSON.stringify(patch)).toEqual(['writer-steps']);
      expect(plan.rewritesStructure, JSON.stringify(patch)).toBe(true);
      expect(plan.incremental, JSON.stringify(patch)).toBe(false);
    }
  });

  it('reports a page-composition save as a structural rewrite', () => {
    expect(planSave(changes({ pageOrder: true })).rewritesStructure).toBe(true);
  });

  it('applies the requested encryption even for a plain input', () => {
    const plan = planSave(changes({ encryption: true }));
    expect(plan.steps.map((step) => step.id)).toEqual(['qpdf-encrypt']);
    expect(plan.reprotects).toBe(false);
    expect(plan.incremental).toBe(false);
  });

  it('lets a redaction win over page composition as the base path', () => {
    const plan = planSave(changes({ redaction: true, pageOrder: true }));
    expect(ids(plan.paths)).toEqual(['mupdf-rewrite', 'metadata-write']);
  });

  it('decrypts an encrypted input before a redaction, metadata or box change', () => {
    for (const patch of [{ redaction: true }, { metadata: true }, { boxes: true }]) {
      const plan = planSave(changes(patch), { encryptedInput: true });
      expect(plan.decryptsInput, JSON.stringify(patch)).toBe(true);
      expect(plan.steps[0]?.id, JSON.stringify(patch)).toBe('decrypt-input');
    }
  });
});
