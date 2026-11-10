import { expect, test } from '@playwright/test';
import { seedProject, seedRun, unique } from './helpers';

// Every main page fits a phone screen: no sideways scrolling.
test('pages fit a phone without horizontal scrolling', async ({ page, request }) => {
  const { id, token } = await seedProject(request, unique('phone'));
  const run = await seedRun(request, token, { name: 'phone run with a fairly long name', startedAt: '2026-11-09T10:00:00Z', high: 2, medium: 2 });
  for (const path of ['/', `/projects/${id}`, `/projects/${id}?tab=runs`, `/projects/${id}?tab=tokens`, `/projects/${id}/scenarios`, `/runs/${run}`, `/runs/${run}?tab=timeline`, '/guides']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const { overflow, culprits } = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      culprits: [...document.querySelectorAll('main *')]
        .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1)
        .slice(0, 3)
        .map((e) => `${e.tagName.toLowerCase()}.${e.className}`),
    }));
    expect(overflow, `${path} scrolls sideways by ${overflow}px (${culprits.join(', ')})`).toBeLessThanOrEqual(0);
  }
});
