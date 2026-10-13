import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(resolve('../Anas/package.json'));
const { expect } = require('playwright/test');

/** Real host/worker/tools, with an isolated local model endpoint. No RDP data leaves the test. */
export async function verifyToolCalls(page, sessionId, profiles, backend, readInputEvents) {
  let mode = 'list_profiles', responseCount = 0, imageObserved = false, connectionStep = 0, profile, connectedId, showLocation = 'sidebar', toolLocked = true, cancelInput = false;
  let backgroundInput = false, backgroundCallId, backgroundObserved = false, backgroundCompleted = false;
  let stopInput = false;
  const errors = [];
  const server = createServer((request, response) => {
    void (async () => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body), last = input.messages.at(-1);
      const sequence = ++responseCount;

      const result = last.role === 'tool' || (Array.isArray(last.content) && last.content.some(block => block.type === 'image_url'));
      if (result && mode === 'list_profiles') assert.ok(JSON.stringify(last).includes('hasPassword'), 'Profile tool must return profiles, not an error.');
      if (result && mode === 'list_sessions') assert.ok(JSON.stringify(last).includes(sessionId), 'Session query must return the original resource.');
      if (result && mode === 'screenshot') {
        const block = input.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
          .find(block => block.type === 'image_url' && block.image_url.url.startsWith('data:image/png;base64,'));
        assert.ok(block, 'The RDP image must reach the ordinary model image projection.');
        const png = Buffer.from(block.image_url.url.split(',')[1], 'base64');
        assert.ok(png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0);
        imageObserved = true;
      }
      if (result && mode === 'set_ui_locked') assert.deepEqual(JSON.parse(last.content), { session_id: sessionId, ui_locked: toolLocked });
      if (result && mode === 'reset_keyboard') { const data = JSON.parse(last.content); assert.equal(data.accepted, true); assert.equal(data.toggle_flags, 0); }
      if (result && mode === 'input' && !stopInput) {
        const data = JSON.parse(last.content);
        if (backgroundInput) {
          assert.ok(data.call_id, 'Long input must return a managed call ID.');
          if (backgroundCallId) assert.equal(data.call_id, backgroundCallId);
          backgroundCallId = data.call_id;
          backgroundObserved = true;
          if (data.terminal) {
            assert.equal(data.status, 'completed');
            assert.equal(data.outcome.ok, true);
            backgroundCompleted = true;
          }
        } else assert.equal(data.accepted, true);
      }
      if (result && mode === 'show_desktop') {
        const data = JSON.parse(last.content);
        assert.equal(data.id, sessionId);
        assert.equal(data.view.location, showLocation);
      }
      if (result && mode === 'connect') {
        const data = JSON.parse(last.content);
        assert.equal(data.ui_locked, false, 'A new connection starts unlocked.');
        assert.equal(data.state, 'connected', 'Connection must report a real authenticated session.');
        assert.equal(data.view, null, 'A successful connection does not imply a visible desktop.');
        assert.equal(data.reused, connectionStep > 0);
        if (connectionStep === 0) connectedId = data.id;
        else assert.equal(data.id, connectedId, 'A second connect must reuse the same session.');
        connectionStep++;
      }
      const again = !result || (mode === 'connect' && connectionStep < 2) || (backgroundInput && !backgroundCompleted);
      const name = input.tools.find(tool => tool.function.name === (backgroundCallId ? 'wait_call' : `plugin__rdp__${mode}`))?.function.name;
      assert.ok(name, 'The selected RDP tool must reach the model.');
      const args = backgroundCallId ? { summary: 'Wait for the original RDP input', call_id: backgroundCallId, timeout: 30 }
        : backgroundInput || stopInput ? { session_id: sessionId, interval_ms: 1000, actions: Array.from({length:12}, (_, n) => ({type:'move',x:45+n,y:45})) }
        : mode === 'connect' ? { profile_id: profile.id, revision: profile.revision }
        : mode === 'set_ui_locked' ? { session_id: sessionId, locked: toolLocked }
        : mode === 'input' ? cancelInput
          ? { session_id: sessionId, interval_ms: 1000, actions: Array.from({length:5}, (_, n) => ({type:'move',x:45+n,y:45})) }
          : { session_id: sessionId, actions: [{type:'move',x:45,y:45},{type:'key',code:42,down:true}] }
        : mode === 'show_desktop' ? { session_id: sessionId, location: showLocation }
        : ['screenshot', 'disconnect', 'reset_keyboard'].includes(mode) ? { session_id: sessionId } : {};
      const calls = again ? [{ id: `rdp-${sequence}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] : undefined;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: `response-${sequence}`, object: 'chat.completion', created: 1, model: input.model,
        choices: [{ index: 0, finish_reason: calls ? 'tool_calls' : 'stop', message: { role: 'assistant',
          content: calls ? null : `RDP_${mode}_${mode === 'connect' ? profile.runInBackground : ''}_FINISHED`, ...(calls ? { tool_calls: calls } : {}) } }],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } }));
    })().catch(() => { errors.push('Local model verification failed.'); response.writeHead(500); response.end(); });
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await page.evaluate(async port => {
      const saved = await gale.config.saveModelProvider({ name: 'RDP test', protocol: 'openai_chat_completions', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: '', parameters: {}, modelListAuth: 'bearer' });
      const providerId = saved.providers.find(provider => provider.name === 'RDP test').id;
      const configured = await gale.config.saveProviderModel({ providerId, displayName: 'RDP test', model: 'rdp-test', parameters: {}, parameterPresetMode: 'none', parameterPresets: [],
        capabilities: { vision: true, toolUse: true }, stream: false, maxContextTokens: 128000, maxOutputTokens: 1000, contextCompressionThreshold: 0.8, contextCompressionEnabled: false });
      await gale.config.selectDefaultModel(configured.providers.find(provider => provider.id === providerId).models[0].id);
      const base = (await gale.projects.list()).find(project => project.id === 'default-workspace');
      const project = await gale.projects.create({ ...base, name: 'RDP tools fixture', advancedSettings: true, accessMode: 'full_access',
        capabilities: { ...base.capabilities,
          toolMode: 'selected', tools: [], planning: false, environment: false, profile: false, workspace: false, memory: false,
          applicationEnvironment: false, skills: { mode: 'off', project: false, entries: [] }, subagents: { mode: 'off', names: [] },
          mcp: { defaultMode: 'selected', servers: [] }, customTools: { mode: 'off', project: false, entries: [] },
          backgroundTools: true, pluginMode: 'custom', plugins: [{ id: 'rdp', mode: 'custom' }], pluginPrompts: [],
          pluginTools: ['connect', 'list_profiles', 'list_sessions', 'screenshot', 'input', 'reset_keyboard', 'set_ui_locked', 'show_desktop', 'disconnect'].map(id => `rdp:tool:${id}`) } });
      if (project.status !== 'ok') throw new Error(JSON.stringify(project));
      await gale.agent.workspace.set({ mode: 'new_thread', projectId: project.value.id, modelParameterPresetId: null });
    }, server.address().port);
    // A settings update does not require reconstructing any RDP display page.
    await page.reload();
    await page.locator('[data-agent-composer-input]').waitFor({ timeout: 45000 });
    assert.equal(await page.locator('iframe').count(), 0);
    for (mode of ['list_profiles', 'list_sessions', 'set_ui_locked', 'screenshot', 'input', 'reset_keyboard']) {
      await page.locator('[data-agent-composer-input]').fill(`Verify RDP tool ${mode}.`);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByText(`RDP_${mode}_${mode === 'connect' ? profile.runInBackground : ''}_FINISHED`, { exact: true })).toBeVisible({ timeout: 35000 });
      assert.equal(await page.locator('iframe').count(), 0);
    }
    mode = 'input'; cancelInput = true;
    const inputEventCount = (await readInputEvents()).length;
    const currentInputEvents = async () => (await readInputEvents()).slice(inputEventCount);
    await page.locator('[data-agent-composer-input]').fill('Start the four-second input sequence, then cancel this turn.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(async () => (await currentInputEvents()).some(item => item.event === 'started'), { intervals: [25], timeout: 15000 }).toBe(true);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.poll(async () => (await currentInputEvents()).some(item => item.event === 'completed'), { timeout: 10000 }).toBe(true);
    const inputEvents = await currentInputEvents();
    assert.deepEqual(inputEvents.map(item => item.event), ['started', 'cancelled', 'completed']);
    assert.ok(inputEvents[1].at - inputEvents[0].at < 1000, 'Cancel early enough to cover the former three-second backend termination bug.');
    assert.ok(inputEvents[2].at - inputEvents[0].at >= 4000);
    assert.equal(inputEvents[2].accepted, true, 'Cancellation must preserve the real native receipt.');
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    assert.equal((await page.evaluate(() => gale.plugins.list())).find(plugin => plugin.id === 'rdp').backendStatus, 'running');
    assert.equal((await backend('find', { owner: 'model-tool-test' })).id, sessionId, 'Cancelled input must retain the independent RDP connection.');
    assert.equal((await backend('status', { owner: 'model-tool-test', id: sessionId })).state, 'connected');
    cancelInput = false;
    backgroundInput = true;
    const longEventCount = (await readInputEvents()).length;
    const inputMessages = await page.getByText('RDP_input__FINISHED', { exact: true }).count();
    await page.locator('[data-agent-composer-input]').fill('Run the eleven-second input and wait for the same background call.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('RDP_input__FINISHED', { exact: true })).toHaveCount(inputMessages + 1, { timeout: 45000 });
    assert.equal(backgroundObserved, true);
    assert.equal(backgroundCompleted, true);
    const longEvents = (await readInputEvents()).slice(longEventCount);
    assert.deepEqual(longEvents.map(event => event.event), ['started', 'completed'], 'Background waiting must not replay or cancel input.');
    assert.ok(longEvents[1].at - longEvents[0].at >= 11000);
    backgroundInput = false; backgroundCallId = undefined;
    mode = 'show_desktop';
    let panelId, shown = 0;
    for (showLocation of ['sidebar', 'window', 'window', 'sidebar']) {
      await page.locator('[data-agent-composer-input]').fill('Show the same desktop in ' + showLocation);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByText('RDP_show_desktop__FINISHED', { exact: true })).toHaveCount(++shown, { timeout: 45000 });
      const views = await page.evaluate(() => gale.panels.list());
      const desktops = views.filter(view => view.content.kind === 'plugin' && view.content.pluginId === 'rdp');
      assert.equal(desktops.length, 1);
      panelId ??= desktops[0].viewId;
      assert.equal(desktops[0].viewId, panelId);
      assert.equal(desktops[0].location, showLocation);
      await expect.poll(async () => (await page.evaluate(() => gale.panels.list())).find(view => view.viewId === panelId)?.toolbar?.actions.find(action => action.id === 'ui-lock')?.pressed).toBe(true);
      assert.equal((await backend('find', { owner: 'model-tool-test' })).id, sessionId);
    }
    await page.evaluate(id => gale.panels.close(id), panelId);
    mode = 'set_ui_locked'; toolLocked = false;
    await page.locator('[data-agent-composer-input]').fill('Unlock local input for the existing session.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('RDP_set_ui_locked__FINISHED', { exact: true })).toHaveCount(2, { timeout: 35000 });
    mode = 'disconnect';
    await page.locator('[data-agent-composer-input]').fill('Disconnect the test session.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('RDP_disconnect__FINISHED', { exact: true })).toBeVisible({ timeout: 35000 });
    mode = 'connect';
    for (profile of profiles) {
      mode = 'connect'; connectionStep = 0;
      await page.locator('[data-agent-composer-input]').fill('Connect to the saved server and reuse its connection.');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByText(`RDP_connect_${profile.runInBackground}_FINISHED`, { exact: true })).toBeVisible({ timeout: 50000 });
      assert.equal(await page.locator('iframe').count(), 0);
      assert.equal((await backend('find', { owner: profile.id })).id, connectedId, 'Completing a conversation turn must leave the connection intact.');
      mode = 'input'; sessionId = connectedId;
      const completedInputs = await page.getByText('RDP_input__FINISHED', { exact: true }).count();
      await page.locator('[data-agent-composer-input]').fill('Use the existing connection in the next turn.');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByText('RDP_input__FINISHED', { exact: true })).toHaveCount(completedInputs + 1, { timeout: 35000 });
      assert.equal((await backend('find', { owner: profile.id })).id, connectedId);
      if (profile !== profiles.at(-1)) {
        await backend('disconnect', { owner: profile.id, id: connectedId });
      } else {
        stopInput = true;
        const beforeStop = (await readInputEvents()).length;
        await page.locator('[data-agent-composer-input]').fill('Start a long input sequence for explicit plugin shutdown verification.');
        await page.getByRole('button', { name: 'Send', exact: true }).click();
        await expect.poll(async () => (await readInputEvents()).slice(beforeStop).some(event => event.event === 'started'), { intervals: [25], timeout: 15000 }).toBe(true);
        // This must finish cooperatively. A forced kill rejects stopBackend with
        // cleanup timed out, even if the OS later reclaims the connection helper.
        await page.evaluate(() => gale.plugins.stopBackend('rdp'));
        assert.equal((await page.evaluate(() => gale.plugins.list())).find(plugin => plugin.id === 'rdp').backendStatus, 'stopped');
        const stopped = (await readInputEvents()).slice(beforeStop);
        assert.deepEqual(stopped.map(event => event.event), ['started', 'cancelled', 'failed']);
        assert.match(stopped.at(-1).error, /RDP_SESSION_CLOSED/);
        await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 10000 });
      }
    }
    assert.equal(imageObserved, true);
    assert.deepEqual(errors, []);
    const persistedImage = await page.evaluate(async () => {
      const [thread] = await gale.agent.threads.list();
      return JSON.stringify(await gale.agent.threads.get(thread.id)).includes('iVBORw0KGgo');
    });
    assert.equal(persistedImage, true, 'The ordinary conversation history must retain the screenshot.');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
