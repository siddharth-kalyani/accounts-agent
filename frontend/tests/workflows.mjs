import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

export async function extendedWorkflows({ page, browser, app }) {
  const nav = async name => page.getByRole('button', { name, exact: true }).click();
  const office = async name => {
    await page.locator('.office-pick > button').click();
    await page.getByRole('option', { name, exact: true }).click();
  };
  await nav('Offices');
  const form = page.locator('.office-form');
  await form.getByLabel('Office name', { exact: true }).fill('Browser Annex');
  // An office can start with more than one Office Manager.
  const pickPerson = async (email) => {
    await form.getByLabel('Search people').fill(email);
    await form.getByRole('button', { name: new RegExp(email.replaceAll('.', '\\.')) }).click();
  };
  await pickPerson(app.manager.email);
  await pickPerson(app.otherManager.email);
  await expect(form.getByLabel('Chosen Office Managers').locator('.role-chip')).toHaveCount(2);
  await form.getByRole('button', { name: 'Add office', exact: true }).click();
  await expect(page.locator('.office-pick > button')).toHaveText('Browser Annex');
  const managersAt = await page.evaluate(async (officeName) => {
    const roster = await fetch('/api/access', { credentials: 'same-origin' }).then((response) => response.json());
    const offices = await fetch('/api/offices', { credentials: 'same-origin' }).then((response) => response.json());
    const office = offices.offices.find((item) => item.name === officeName);
    return roster.people.filter((person) => person.grants.some((grant) => grant.role === 'office_manager' && grant.officeId === office.id)).map((person) => person.email).sort();
  }, 'Browser Annex');
  assert.deepEqual(managersAt, [app.manager.email, app.otherManager.email].sort());
  await expect(page.getByRole('heading', { name: 'Coffee', exact: true })).toBeVisible();
  await office('All offices');
  await expect(page.getByRole('heading', { name: 'Browser Annex', exact: true })).toBeVisible();
  await office('Ahmedabad');
  await nav('Record');
  await nav('Product');
  await page.locator('.record-form').getByLabel('Name', { exact: true }).fill('Browser oats');
  await nav('Save');
  await expect(page.locator('.record-form').getByLabel('Name', { exact: true })).toHaveValue('');
  await page.locator('.side').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Lookback months').fill('4');
  await page.getByLabel('Weekend weight').fill('0.3');
  // Before saving, the preview shows how run-out dates would move. Nothing is saved yet.
  await expect(page.locator('.settings-preview')).toContainText(/→|No run-out date changes/);
  await nav('Full day');
  await expect(page.getByLabel('Weekend weight')).toHaveValue('1');
  await page.getByLabel('Weekend weight').fill('0.3');
  await nav('Save');
  await expect(page.getByLabel('Lookback months')).toHaveValue('4');
  await expect(page.getByLabel('Weekend weight')).toHaveValue('0.3');
  await nav('Stock');
  await expect(page.getByRole('heading', { name: 'Browser oats', exact: true })).toBeVisible();
  const download = page.waitForEvent('download');
  await nav('Download month');
  const csv = await download;
  assert.match(csv.suggestedFilename(), /^Ahmedabad-\d{4}-\d{2}\.csv$/);
  const stream = await csv.createReadStream();
  let content = '';
  for await (const chunk of stream) content += chunk;
  assert.ok(content.includes('Coffee beans') && content.includes('25.50'));
  await nav('Charts');
  await expect(page.locator('main.page svg').first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Stock', exact: true })).toBeVisible();
  await nav('Activity');
  await expect(page.locator('main.page')).toContainText('Browser oats');
  await expect(page.locator('.activity-date').first()).toBeVisible();
  await page.getByRole('group', { name: 'Show activity' }).getByRole('button', { name: 'Products', exact: true }).click();
  await expect(page.locator('main.page')).toContainText('Browser oats');
  await expect(page.locator('.activity-day li').filter({ hasText: /Entered \d+ packs/ })).toHaveCount(0);
  await page.getByRole('group', { name: 'Show activity' }).getByRole('button', { name: 'All', exact: true }).click();

  await nav('Open assistant');
  const chat = page.getByRole('dialog', { name: 'Assistant' });
  await expect(chat.getByRole('group', { name: 'Try asking' })).toBeVisible();
  const send = async text => {
    await chat.getByLabel('Message the assistant').fill(text);
    await chat.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(chat.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  };
  await send('how much milk is left at Ahmedabad?');
  await expect(chat.locator('.bubble.assistant').last()).toContainText('Milk');
  await send('delete Browser oats at Ahmedabad');
  await expect(chat.getByRole('button', { name: 'Confirm', exact: true })).toBeVisible();
  await chat.getByRole('button', { name: 'Leave unsaved' }).click();
  await expect(chat.getByRole('button', { name: 'Confirm', exact: true })).toHaveCount(0);
  await send('delete Browser oats at Ahmedabad');
  await chat.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(chat.locator('.bubble.assistant').last()).toContainText(/deleted|removed/i);
  await chat.getByRole('button', { name: 'Past chats' }).click();
  await expect(chat.locator('.thread-row').first()).toBeVisible();
  await chat.locator('.thread-row').first().click();
  await expect(chat.locator('.bubble.assistant').last()).toContainText(/deleted|removed/i);
  await chat.getByRole('button', { name: 'Close assistant', exact: true }).click();
  await nav('Stock');
  await expect(page.getByRole('heading', { name: 'Browser oats', exact: true })).toHaveCount(0);

  await nav('Access');
  await nav('Connect directory search');
  const toast = page.locator('.toast').filter({ hasText: 'Directory search is under development.' });
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(toast).toHaveCount(0);
  // The only active Super Admin cannot be removed or turned off, so the screen does not offer it.
  const lastSuper = page.locator('.access-list li').filter({ hasText: app.admin.email });
  await expect(lastSuper).toContainText('The only Super Admin.');
  assert.equal(await lastSuper.getByRole('button', { name: /Remove Super Admin/ }).count(), 0);
  assert.equal(await lastSuper.getByRole('button', { name: 'Turn off', exact: true }).count(), 0);
  const peopleSearch = page.getByLabel('Search people on the access list');
  await peopleSearch.fill(app.manager.email);
  await expect(page.locator('.access-list li')).toHaveCount(1);
  await peopleSearch.fill('nobody-matches-this');
  await expect(page.getByText('No person matches that search.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(page.locator('.access-list li').filter({ hasText: app.manager.email })).toHaveCount(1);
  const email = 'browser.invitee@intuitive.AI';
  await nav('Invite person');
  const drawer = page.getByRole('dialog', { name: 'Invite or give access' });
  await drawer.getByLabel('Email to invite').fill(email);
  await drawer.locator('.access-form').first().getByLabel('Name', { exact: true }).fill('Browser Invitee');
  await drawer.getByRole('button', { name: 'Invite', exact: true }).click();
  const temporary = await drawer.locator('.invite-secret code').innerText();
  const grant = drawer.locator('.access-form').last();
  await expect(grant.getByLabel('Sign-in name')).toHaveValue(email);
  await grant.getByLabel('Name', { exact: true }).fill('Browser Invitee');
  await grant.getByLabel('Sign-in name').fill(email);
  await grant.locator('select').first().selectOption('accounts');
  await grant.locator('select').last().selectOption({ label: 'Ahmedabad' });
  await drawer.getByRole('button', { name: 'Save access', exact: true }).click();
  await expect(page.locator('main .notice')).toHaveText('Access saved.');
  await drawer.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(drawer).toHaveCount(0);
  const invited = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const user = await invited.newPage();
    await user.goto(app.base);
    await user.getByLabel('Email', { exact: true }).fill(email);
    await user.getByLabel('Password', { exact: true }).fill(temporary);
    await user.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(user.getByRole('heading', { name: 'Choose a password' })).toBeVisible();
    await expect(user.getByLabel('Email', { exact: true })).toHaveValue(email);
    await user.getByLabel('New password', { exact: true }).fill('Invited pantry door 42');
    await user.getByLabel('Confirm password', { exact: true }).fill('Invited pantry door 99');
    await user.getByRole('button', { name: 'Save password' }).click();
    await expect(user.getByText('Those passwords do not match.')).toBeVisible();
    await user.getByLabel('Confirm password', { exact: true }).fill('Invited pantry door 42');
    await user.getByRole('button', { name: 'Save password' }).click();
    await expect(user.getByRole('heading', { name: 'Coffee beans', exact: true })).toBeVisible();
    assert.equal(await user.getByRole('button', { name: 'Edit Coffee beans', exact: true }).count(), 0);
    assert.equal(await user.getByRole('button', { name: "Today's stock", exact: true }).count(), 0);
    await user.getByRole('button', { name: 'Open menu' }).click();
    assert.equal(await user.getByRole('button', { name: 'Access', exact: true }).count(), 0);
    await user.getByRole('button', { name: 'Record', exact: true }).click();
    await expect(user.getByText(/It cannot change the pantry/)).toBeVisible();
    const person = page.locator('.access-list li').filter({ hasText: email });
    const undoToast = (text) => page.locator('.toast').filter({ hasText: text });
    // Undo puts the role straight back and nothing is sent.
    await person.getByRole('button', { name: /Remove Accounts/ }).click();
    await expect(person).toContainText('No role yet');
    await undoToast('Removed Accounts').getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(person.getByRole('button', { name: /Remove Accounts/ })).toBeVisible();
    // Closing the toast sends the removal.
    await person.getByRole('button', { name: /Remove Accounts/ }).click();
    const removal = page.waitForResponse((response) => response.request().method() === 'DELETE' && /\/api\/access\/[^/]+\/grants\//.test(response.url()));
    await undoToast('Removed Accounts').getByRole('button', { name: 'Close', exact: true }).click();
    assert.equal((await removal).status(), 200);
    await expect(person).toContainText('No role yet');
    await user.reload();
    await expect(user.getByText(/No office/).first()).toBeVisible();
    await person.getByRole('button', { name: 'Turn off', exact: true }).click();
    await expect(person).toContainText('Turned off');
    const off = page.waitForResponse((response) => response.request().method() === 'POST' && /\/api\/access\/[^/]+\/active$/.test(response.url()));
    await undoToast('Turned off').getByRole('button', { name: 'Close', exact: true }).click();
    assert.equal((await off).status(), 200);
    await user.reload();
    await expect(user.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    await person.getByRole('button', { name: 'Turn on', exact: true }).click();
    await expect(person.getByRole('button', { name: 'Turn off' })).toBeVisible();
    await user.reload();
    await expect(user.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  } finally { await invited.close(); }
  // Read-only Admin sees all offices, but cannot write or administer access.
  const observer = await browser.newContext();
  try {
    const user = await observer.newPage();
    await user.goto(app.base);
    await user.getByLabel('Email', { exact: true }).fill(app.observer.email);
    await user.getByLabel('Password', { exact: true }).fill(app.password);
    await user.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(user.getByRole('button', { name: 'Stock', exact: true })).toBeVisible();
    assert.equal(await user.getByRole('button', { name: 'Access', exact: true }).count(), 0);
    assert.equal(await user.getByRole('button', { name: 'Add office', exact: true }).count(), 0);
    await user.locator('.office-pick > button').click();
    await user.getByRole('option', { name: 'All offices', exact: true }).click();
    await expect(user.getByRole('heading', { name: 'Browser Annex', exact: true })).toBeVisible();
  } finally { await observer.close(); }
  await nav('Stock');
}
