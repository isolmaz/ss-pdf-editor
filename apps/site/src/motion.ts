/**
 * The page's own motion: the navigation hairline, the light/dark switch, the headline that types
 * its way through what can be done to a PDF, and the scroll reveals. `theme-boot.js` has already
 * applied the stored theme before the first paint; without JavaScript every section is simply
 * visible, and with reduced motion the CSS turns the transitions off.
 */
const root = document.documentElement;
root.classList.add('js');

const nav = document.querySelector('.nav') as HTMLElement;
let scrolled: boolean | null = null;
const onScroll = (): void => {
  const now = window.scrollY > 8;
  if (now === scrolled) return;
  scrolled = now;
  nav.classList.toggle('scrolled', now);
};
onScroll();
window.addEventListener('scroll', onScroll, { passive: true });

// The theme is the editor's own setting (`pdf-editor.theme`, read by theme-boot.js), so a choice
// made here is the one the editor opens with, and the reverse.
(document.querySelector('.theme-toggle') as HTMLElement).addEventListener('click', () => {
  const mode = root.dataset.mode === 'dark' ? 'light' : 'dark';
  root.classList.add('theme-switching');
  root.style.colorScheme = mode;
  root.dataset.mode = mode;
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
  try {
    localStorage.setItem('pdf-editor.theme', mode);
  } catch {
    // Storage may be blocked; the switch still holds for this page.
  }
});

// The middle word of the headline is deleted one character at a time and the next one is typed,
// behind the caret CSS draws. Below 600px a longer word would wrap and move the hero on every
// keystroke, so there, with reduced motion and without JavaScript, the word in the HTML stays.
const swap = document.querySelector<HTMLElement>('.swap');
if (swap && !window.matchMedia('(prefers-reduced-motion: reduce), (max-width: 599px)').matches) {
  const words = (swap.dataset.words as string).split('|');
  swap.classList.add('typing');
  const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
  void (async () => {
    for (let index = 1; ; index = (index + 1) % words.length) {
      await wait(2600);
      for (let left = swap.textContent.length; left > 0; left--) {
        swap.textContent = swap.textContent.slice(0, left - 1);
        await wait(36);
      }
      await wait(240);
      for (const character of words[index] as string) {
        swap.textContent += character;
        await wait(64);
      }
    }
  })();
}

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('in');
      observer.unobserve(entry.target);
    }
  },
  { rootMargin: '0px 0px -8% 0px', threshold: 0.1 },
);
for (const item of document.querySelectorAll('.reveal')) observer.observe(item);
