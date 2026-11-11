import { expect, test } from '@playwright/test';
import { seedProject, seedRun, unique } from './helpers';

// Every main page fits a phone screen: no sideways scrolling.
test('pages fit a phone without horizontal scrolling', async ({ page, request }) => {
  const { id, token } = await seedProject(request, unique('phone'));
  const run = await seedRun(request, token, { name: 'phone run with a fairly long name', startedAt: '2026-11-09T10:00:00Z', high: 2, medium: 2, amountMinor: 987654321 });
  const pr = await seedRun(request, token, {
    name: 'pull request run', startedAt: '2026-11-09T11:00:00Z', high: 1, amountMinor: 125000,
    ci: { provider: 'github', repo: 'acme/a-rather-long-repository-name', branch: 'feature/a-rather-long-branch-name-for-phones', commit: 'abcdef1234567',
      pr_number: 12345, base_branch: 'main', url: 'https://github.com/acme/a-rather-long-repository-name/actions/runs/1' },
  });
  for (const path of ['/', `/projects/${id}`, `/projects/${id}?tab=issues`, `/projects/${id}?tab=runs`, `/projects/${id}?tab=tokens`, `/projects/${id}/scenarios`, `/runs/${run}`, `/runs/${run}?tab=timeline`, `/runs/${pr}`, '/guides']) {
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
