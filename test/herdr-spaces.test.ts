import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spaceLayout, dropSpace } from '../src/herdr-spaces.ts';
import { herdrAction, herdrSnapshot } from '../server/herdr.ts';
import { herdrFixture } from './herdr-fixture.ts';

test('space stacks support edge reordering, joining, extraction and closed members without losing spaces', () => {
  let layout = spaceLayout(['a', 'b', 'c', 'd'], []);
  layout = dropSpace(layout, 'a', 'c', 'group');
  assert.deepEqual(layout, { order: ['b', 'c', 'a', 'd'], groups: [['c', 'a']] });
  layout = dropSpace(layout, 'd', 'a', 'group');
  assert.deepEqual(layout.groups, [['c', 'a', 'd']]);
  layout = dropSpace(layout, 'a', 'b', 'before');
  assert.deepEqual(layout, { order: ['a', 'b', 'c', 'd'], groups: [['c', 'd']] });
  layout = dropSpace(layout, 'c', 'b', 'after');
  assert.deepEqual(layout, { order: ['a', 'b', 'c', 'd'], groups: [] });
  assert.equal(dropSpace(layout, 'a', 'a', 'group'), layout);
  assert.deepEqual(spaceLayout(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']], ['a', 'c', 'd']), { order: ['a', 'c', 'd'], groups: [] });
  assert.deepEqual(spaceLayout(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c', 'd']]).groups, [['a', 'b'], ['c', 'd']], 'A space belongs to only one stack');
});

test('space creation follows the selected terminal directory and ordering changes the Herdr server', async () => {
  const fixture = await herdrFixture(), target = { session: '', socketPath: fixture.socketPath };
  try {
    fixture.snapshot.agents[1].foreground_cwd = '/workspace/sub project';
    await assert.rejects(herdrAction(target, { action: 'create-space', workspaceId: 'closed' }), /closed/);
    assert.ok(!fixture.actions.some(action => action.method === 'workspace.create'));
    const created = await herdrAction(target, { action: 'create-space', workspaceId: 'w1', terminalId: 'term_1' });
    assert.deepEqual(fixture.actions.find(action => action.method === 'workspace.create').params, { focus: false, source_workspace_id: 'w1', cwd: '/workspace/sub project' });
    const snapshot = await herdrSnapshot(target), space = snapshot.spaces!.find(space => space.id === created.workspaceId)!;
    assert.equal(space.cwd, '/workspace/sub project'); assert.equal(space.selectedTerminalId, created.terminalId);
    assert.equal(snapshot.agents.length, 3, 'A new space starts with a shell');
    await herdrAction(target, { action: 'move-space', workspaceId: created.workspaceId, beforeWorkspaceId: 'w1' });
    assert.equal((await herdrSnapshot(target)).spaces![0].id, created.workspaceId);
    await assert.rejects(herdrAction(target, { action: 'move-space', workspaceId: 'closed' }), /closed/);
    await assert.rejects(herdrAction(target, { action: 'move-space', workspaceId: 'w1', beforeWorkspaceId: 'w1' }), /another/);
    await herdrAction(target, { action: 'rename-space', workspaceId: created.workspaceId, name: 'Review' });
    assert.equal((await herdrSnapshot(target)).spaces![0].name, 'Review');
  } finally { await fixture.close(); }
});
