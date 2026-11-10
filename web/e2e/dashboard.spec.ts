import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { seedProject, seedRun, unique } from './helpers';

test('create a project and an ingest token from the UI', async ({ page }) => {
  const name = unique('ui-project');
  await page.goto('/');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel(/Description/).fill('created by the browser test');
  await page.getByRole('button', { name: 'Create project' }).click();

  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await expect(page.getByText('created by the browser test')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Get started' })).toBeVisible();

  await page.getByRole('tab', { name: 'Tokens' }).click();
  await page.getByLabel('Token label').fill('ci');
  await page.getByRole('button', { name: 'New token' }).click();
  await expect(page.getByText('Copy this token now.')).toBeVisible();
  await expect(page.locator('pre.copy').first()).toHaveText(/^pct_[A-Za-z0-9_-]{43}$/);
  await page.getByRole('button', { name: "I've saved it" }).click();
  await expect(page.getByRole('cell', { name: 'never' })).toBeVisible();

  // Revoking asks first; cancelling keeps the token.
  await page.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Revoke' }).click();
  await page.getByRole('button', { name: 'Revoke token' }).click();
  await expect(page.getByText(/^revoked/)).toBeVisible();
  await expect(page.getByText('Token revoked')).toBeVisible();
});

test('project health, trend, compare, run detail, fix guide, export and delete', async ({ page, request }) => {
  const name = unique('health');
  const { id, token } = await seedProject(request, name);
  await seedRun(request, token, { name: 'before fix', startedAt: '2026-11-08T10:00:00Z', high: 0, medium: 1 });
  const bad = await seedRun(request, token, { name: 'regressed', startedAt: '2026-11-09T10:00:00Z', high: 2, medium: 1 });

  await page.goto(`/projects/${id}`);
  await expect(page.locator('.kpi .health')).toHaveText(/Failing/);
  await expect(page.getByText('+2 new')).toBeVisible();
  await expect(page.locator('.chart-plot .col')).toHaveCount(2);
  await expect(page.getByText('Retry created a duplicate payment')).toBeVisible();

  // Compare from the overview link.
  await page.getByRole('link', { name: 'Compare' }).click();
  await expect(page.getByText(/Regressed: new findings up to/)).toBeVisible();
  await expect(page.locator('tr.worse td.delta')).toHaveText('+2');

  // Run page from the projects runs tab.
  await page.goto(`/projects/${id}?tab=runs`);
  await page.getByRole('link', { name: 'regressed' }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${bad}`));
  await expect(page.getByRole('link', { name })).toBeVisible(); // breadcrumb shows the project's name
  await page.getByRole('button', { name: 'How to fix this' }).first().click();
  await expect(page.getByText('How to fix it')).toBeVisible();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Markdown' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('paychaos-regressed.md');
  const md = readFileSync((await file.path())!, 'utf8');
  expect(md).toContain('**2 high**');

  await page.getByRole('tab', { name: 'Retry timeline' }).click();
  await expect(page.getByText('committed, connection reset')).toBeVisible();

  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Delete run' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${id}\\?tab=runs`));
  await expect(page.getByText('Run deleted')).toBeVisible();
  await expect(page.getByRole('link', { name: 'regressed' })).toHaveCount(0);

  // Deleting the project needs its name typed.
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  const confirm = page.getByRole('button', { name: 'Delete project' });
  await expect(confirm).toBeDisabled();
  await page.getByRole('alertdialog').getByRole('textbox').fill(name);
  await confirm.click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('link', { name })).toHaveCount(0);
});

test('scenario editor validates as you type and saves', async ({ page, request }) => {
  const { id } = await seedProject(request, unique('scenarios'));
  await page.goto(`/projects/${id}/scenarios`);
  const editor = page.getByLabel('Scenario JSON');
  await expect(page.getByText('Valid scenario.')).toBeVisible();
  await editor.fill('{"seed": 1, "rules": [{"name": "x", "fault": "explode", "probability": 2}]}');
  await expect(page.locator('.issues li')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await editor.fill('{"seed": 1, "rules": []}');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status').getByText(/Saved lost-responses/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled(); // nothing unsaved
});

test('fix guides page and unknown routes', async ({ page }) => {
  await page.goto('/guides#TOKEN_NOT_REFRESHED');
  await expect(page.locator('#TOKEN_NOT_REFRESHED')).toBeInViewport();
  await page.getByRole('button', { name: 'High' }).click();
  await expect(page.locator('.guide-card')).toHaveCount(1);
  await page.goto('/no/such/page');
  await expect(page.getByText('Page not found')).toBeVisible();
});

test('API responses carry security headers', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(res.headers()['x-content-type-options']).toBe('nosniff');
});
