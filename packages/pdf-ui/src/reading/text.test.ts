import { describe, expect, it } from 'vitest';
import {
  buildReadingBlocks,
  type EngineTextRun,
  type ReadingTextItem,
  splitUtterances,
  toReadingTextItem,
} from './text';

/** A horizontal run: baseline origin `(x, y)`, advance `width`, em `size`. */
function run(text: string, x: number, y: number, width: number, size = 12): ReadingTextItem {
  return { text, x, y, width, size, dx: 1, dy: 0 };
}

describe('toReadingTextItem', () => {
  it('turns an engine run into a placed run with a unit baseline direction', () => {
    const engine: EngineTextRun = { str: 'Hello', transform: [12, 0, 0, 12, 72, 700], width: 30, height: 12 };
    expect(toReadingTextItem(engine)).toEqual({
      text: 'Hello',
      x: 72,
      y: 700,
      width: 30,
      size: 12,
      dx: 1,
      dy: 0,
    });
  });

  it('collapses inner whitespace and trims the text', () => {
    const engine: EngineTextRun = {
      str: '  two \n  words ',
      transform: [1, 0, 0, 1, 0, 0],
      width: 5,
      height: 10,
    };
    expect(toReadingTextItem(engine)?.text).toBe('two words');
  });

  it('reads the baseline direction of a run turned a quarter turn', () => {
    const engine: EngineTextRun = { str: 'Up', transform: [0, 12, -12, 0, 100, 100], width: 20, height: 12 };
    const item = toReadingTextItem(engine);
    expect(item?.dx).toBeCloseTo(0, 12);
    expect(item?.dy).toBeCloseTo(1, 12);
  });

  it('keeps the width positive for a run that reports a negative advance', () => {
    const engine: EngineTextRun = {
      str: 'Back',
      transform: [-10, 0, 0, 10, 200, 50],
      width: -40,
      height: 10,
    };
    const item = toReadingTextItem(engine);
    expect(item?.width).toBe(40);
    expect(item?.dx).toBe(-1);
  });

  it('falls back to the length of the second matrix axis when the run reports no height', () => {
    const engine: EngineTextRun = { str: 'Tall', transform: [10, 0, 3, 4, 0, 0], width: 20, height: 0 };
    expect(toReadingTextItem(engine)?.size).toBe(5);
  });

  it('drops a run without text', () => {
    expect(
      toReadingTextItem({ str: ' \t ', transform: [1, 0, 0, 1, 0, 0], width: 3, height: 10 }),
    ).toBeNull();
    expect(toReadingTextItem({ str: '', transform: [1, 0, 0, 1, 0, 0], width: 3, height: 10 })).toBeNull();
  });

  it('drops a run whose matrix is too short to hold a position', () => {
    expect(toReadingTextItem({ str: 'x', transform: [1, 0, 0, 1], width: 3, height: 10 })).toBeNull();
    expect(toReadingTextItem({ str: 'x', transform: [], width: 3, height: 10 })).toBeNull();
  });

  it('drops a run with a non-finite matrix entry, width or height', () => {
    const base = { str: 'x', transform: [1, 0, 0, 1, 5, 5], width: 3, height: 10 };
    expect(toReadingTextItem({ ...base, transform: [Number.NaN, 0, 0, 1, 5, 5] })).toBeNull();
    expect(toReadingTextItem({ ...base, transform: [1, 0, 0, 1, Number.POSITIVE_INFINITY, 5] })).toBeNull();
    expect(toReadingTextItem({ ...base, width: Number.NaN })).toBeNull();
    expect(toReadingTextItem({ ...base, height: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it('drops a run whose matrix has no horizontal scale', () => {
    expect(toReadingTextItem({ str: 'x', transform: [0, 0, 0, 1, 5, 5], width: 3, height: 10 })).toBeNull();
  });

  it('drops a run that has neither a height nor a second axis to take the em from', () => {
    expect(toReadingTextItem({ str: 'x', transform: [1, 0, 0, 0, 5, 5], width: 3, height: 0 })).toBeNull();
  });
});

describe('buildReadingBlocks', () => {
  it('returns no blocks for no runs', () => {
    expect(buildReadingBlocks([])).toEqual([]);
  });

  it('joins runs of one baseline into one line and puts a space only at a real gap', () => {
    const blocks = buildReadingBlocks([
      run('Hello', 72, 700, 30),
      run('world', 106, 700, 30),
      run('Hel', 72, 686, 18),
      run('lo', 90.5, 686, 12),
    ]);
    expect(blocks).toEqual([{ kind: 'paragraph', text: 'Hello world Hello' }]);
  });

  it('orders the runs of a line by their position along the baseline, whatever order they arrive in', () => {
    const blocks = buildReadingBlocks([run('second', 110, 700, 36), run('first', 72, 700, 30)]);
    expect(blocks).toEqual([{ kind: 'paragraph', text: 'first second' }]);
  });

  it('keeps a superscript on the line of its base', () => {
    const blocks = buildReadingBlocks([run('E=mc', 72, 700, 30), run('2', 102, 706, 6, 8)]);
    expect(blocks).toEqual([{ kind: 'paragraph', text: 'E=mc2' }]);
  });

  it('reads a run turned a quarter turn along its own baseline', () => {
    const up = (text: string, y: number, width: number): ReadingTextItem => ({
      text,
      x: 100,
      y,
      width,
      size: 12,
      dx: 0,
      dy: 1,
    });
    expect(buildReadingBlocks([up('Up', 100, 30), up('ward', 134, 30)])).toEqual([
      { kind: 'paragraph', text: 'Up ward' },
    ]);
  });

  it('classifies a large short block as a heading and splits blocks at a wide gap', () => {
    const blocks = buildReadingBlocks([
      run('Chapter One', 72, 760, 90, 20),
      run('Body line one', 72, 700, 70),
      run('body line two', 72, 686, 70),
      run('body line three', 72, 672, 70),
    ]);
    expect(blocks).toEqual([
      { kind: 'heading', text: 'Chapter One' },
      { kind: 'paragraph', text: 'Body line one body line two body line three' },
    ]);
  });

  it('does not make a long large block a heading', () => {
    const long = 'x'.repeat(81);
    const blocks = buildReadingBlocks([
      run(long, 72, 760, 400, 20),
      run('body', 72, 700, 30),
      run('more', 72, 686, 30),
    ]);
    expect(blocks[0]).toEqual({ kind: 'paragraph', text: long });
  });

  it('does not make a three-line large block a heading', () => {
    const blocks = buildReadingBlocks([
      run('big one', 72, 760, 60, 20),
      run('big two', 72, 736, 60, 20),
      run('big three', 72, 712, 60, 20),
      run('small a', 72, 600, 40),
      run('small b', 72, 586, 40),
      run('small c', 72, 572, 40),
      run('small d', 72, 558, 40),
    ]);
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'paragraph']);
  });

  it('recognises bullets and enumerators as list items', () => {
    const blocks = buildReadingBlocks([
      run('Intro text line', 72, 700, 70),
      run('continues here', 72, 686, 70),
      run('• first item', 72, 640, 60),
      run('wrapped item text', 72, 626, 80),
      run('2. second item', 72, 580, 60),
      run('wrap two', 72, 566, 40),
      run('c) third item', 72, 520, 60),
      run('wrap three', 72, 506, 50),
    ]);
    expect(blocks).toEqual([
      { kind: 'paragraph', text: 'Intro text line continues here' },
      { kind: 'list-item', text: '• first item wrapped item text' },
      { kind: 'list-item', text: '2. second item wrap two' },
      { kind: 'list-item', text: 'c) third item wrap three' },
    ]);
  });

  it('classifies a short block set smaller than the page text as a caption', () => {
    const blocks = buildReadingBlocks([
      run('Body text paragraph here', 72, 700, 120),
      run('more body text', 72, 686, 80),
      run('Figure 1: a caption', 72, 600, 90, 9),
    ]);
    expect(blocks).toEqual([
      { kind: 'paragraph', text: 'Body text paragraph here more body text' },
      { kind: 'caption', text: 'Figure 1: a caption' },
    ]);
  });

  it('keeps a long small block a paragraph', () => {
    const long = 'w'.repeat(161);
    const blocks = buildReadingBlocks([run('Body', 72, 700, 30), run(long, 72, 600, 500, 9)]);
    expect(blocks[1]).toEqual({ kind: 'paragraph', text: long });
  });

  it('starts a new block when the type size jumps even without a wide gap', () => {
    const blocks = buildReadingBlocks([
      run('Title', 72, 700, 40, 14.5),
      run('Body one', 72, 686, 40),
      run('Body two', 72, 672, 40),
    ]);
    expect(blocks.map((block) => block.text)).toEqual(['Title', 'Body one Body two']);
  });

  it('joins a trailing hyphen to a lowercase continuation and keeps the space before a capital', () => {
    expect(buildReadingBlocks([run('keli-', 72, 700, 30), run('me devam', 72, 686, 50)])).toEqual([
      { kind: 'paragraph', text: 'kelime devam' },
    ]);
    expect(buildReadingBlocks([run('Jean-', 72, 700, 30), run('Paul', 72, 686, 30)])).toEqual([
      { kind: 'paragraph', text: 'Jean- Paul' },
    ]);
  });

  it('skips lines that carry no text', () => {
    const blocks = buildReadingBlocks([
      run('', 72, 700, 0),
      run('first', 72, 686, 30),
      run('', 72, 672, 0),
      run('last', 72, 658, 30),
    ]);
    expect(blocks).toEqual([{ kind: 'paragraph', text: 'first last' }]);
  });
});

describe('splitUtterances', () => {
  it('gives nothing to speak for empty or blank text', () => {
    expect(splitUtterances('')).toEqual([]);
    expect(splitUtterances(' \n\t ')).toEqual([]);
  });

  it('splits at sentence ends and normalises whitespace', () => {
    expect(splitUtterances('First   sentence.\nSecond one! Third?')).toEqual([
      'First sentence.',
      'Second one!',
      'Third?',
    ]);
  });

  it('keeps a sentence of up to 180 characters whole', () => {
    const sentence = 'a'.repeat(180);
    expect(splitUtterances(sentence)).toEqual([sentence]);
  });

  it('cuts a long sentence after the last clause end inside the limit', () => {
    const first = `${'a'.repeat(100)},`;
    const second = 'b'.repeat(100);
    expect(splitUtterances(`${first} ${second}`)).toEqual([first, second]);
  });

  it('does not cut at a clause character that is not followed by a space', () => {
    const text = `${'a'.repeat(60)}.5${'b'.repeat(60)} ${'c'.repeat(100)}`;
    // The `.5` is a decimal point; the only place to cut is the word break.
    expect(splitUtterances(text)).toEqual([`${'a'.repeat(60)}.5${'b'.repeat(60)}`, 'c'.repeat(100)]);
  });

  it('cuts at the last word break when the sentence has no clause end', () => {
    const words = Array.from({ length: 60 }, () => 'word');
    const chunks = splitUtterances(words.join(' '));
    expect(chunks).toEqual([words.slice(0, 36).join(' '), words.slice(36).join(' ')]);
  });

  it('cuts a text without any space at the limit', () => {
    expect(splitUtterances('x'.repeat(400))).toEqual(['x'.repeat(180), 'x'.repeat(180), 'x'.repeat(40)]);
  });

  it('never produces a chunk above 180 characters', () => {
    const text = Array.from({ length: 40 }, (_, index) => `clause number ${index},`).join(' ');
    const chunks = splitUtterances(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 180)).toBe(true);
    expect(chunks.join(' ')).toBe(text);
  });
});
