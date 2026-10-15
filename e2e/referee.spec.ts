import { test } from './test';

/**
 * The console referee (`e2e/test.ts`) itself. Each test here breaks a page the way a real
 * defect would and is marked `test.fail()`: it passes only when the referee fails it. A
 * referee that watched only the first page let the two-window specs and the print window
 * log errors unnoticed.
 */

test('fails a test whose second page logs a console error', async ({ context }) => {
  test.fail();
  const second = await context.newPage();
  await second.evaluate(() => console.error('broken on the second page'));
});

test('fails a test whose second page throws an uncaught exception', async ({ context }) => {
  test.fail();
  const second = await context.newPage();
  // The exception is thrown from a timer task: the page reports it as an event, and the test
  // ends only after that event, so the referee has seen it.
  const thrown = second.waitForEvent('pageerror');
  await second.evaluate(() => {
    setTimeout(() => {
      throw new Error('thrown on the second page');
    });
  });
  await thrown;
});
