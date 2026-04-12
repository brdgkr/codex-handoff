const test = require("node:test");
const assert = require("node:assert/strict");

const { AgentController } = require("./agent_controller");

test("AgentController syncs all repos and starts watcher when Codex appears", async () => {
  const states = [];
  const detectorResults = [
    [],
    [{ pid: 101, name: "codex.exe" }],
    [{ pid: 101, name: "codex.exe" }],
  ];
  let syncCalls = 0;
  let watcherStarts = 0;

  const controller = new AgentController({
    detectCodexProcesses: async () => detectorResults.shift() || [],
    performStartupSync: async () => {
      syncCalls += 1;
      return { synced_repo_count: 2 };
    },
    activateWatcher: async () => {
      watcherStarts += 1;
      return { pid: 999 };
    },
    deactivateWatcher: async () => {},
    recordEvent: async () => {},
    writeState: async (payload) => {
      states.push(payload);
    },
    logger: () => {},
  });

  await controller.initialize();
  await controller.tick();

  assert.equal(syncCalls, 1);
  assert.equal(watcherStarts, 1);
  assert.equal(controller.codexRunning, true);
  assert.deepEqual(controller.watcher, { pid: 999 });
  assert.equal(states.at(-1).phase, "watching");
  assert.deepEqual(states.at(-1).last_sync, { synced_repo_count: 2 });
});

test("AgentController stops watcher when Codex disappears", async () => {
  const states = [];
  let stopCalls = 0;
  let shutdownSyncCalls = 0;

  const controller = new AgentController({
    detectCodexProcesses: async () => [{ pid: 101, name: "codex.exe" }],
    performStartupSync: async () => ({ synced_repo_count: 0 }),
    performShutdownSync: async () => {
      shutdownSyncCalls += 1;
      return { synced_repo_count: 1 };
    },
    activateWatcher: async () => ({ pid: 999 }),
    deactivateWatcher: async () => {
      stopCalls += 1;
    },
    recordEvent: async () => {},
    writeState: async (payload) => {
      states.push(payload);
    },
    logger: () => {},
  });

  await controller.initialize();
  controller.codexRunning = true;
  controller.watcher = { pid: 999 };
  controller.detectCodexProcesses = async () => [];

  await controller.tick();

  assert.equal(stopCalls, 1);
  assert.equal(shutdownSyncCalls, 1);
  assert.equal(controller.codexRunning, false);
  assert.equal(controller.watcher, null);
  assert.equal(states.at(-1).phase, "idle");
  assert.deepEqual(states.at(-1).last_shutdown_sync, { synced_repo_count: 1 });
});

test("AgentController keeps watcher active when Codex stays running in background", async () => {
  let stopCalls = 0;
  let backgroundRefreshCalls = 0;

  const controller = new AgentController({
    detectCodexProcesses: async () => [{ pid: 101, name: "codex.exe", hasVisibleWindow: false }],
    performStartupSync: async () => ({ synced_repo_count: 0 }),
    performBackgroundRefresh: async () => {
      backgroundRefreshCalls += 1;
    },
    performShutdownSync: async () => ({ synced_repo_count: 0 }),
    activateWatcher: async () => ({ pid: 999 }),
    deactivateWatcher: async () => {
      stopCalls += 1;
    },
    recordEvent: async () => {},
    writeState: async () => {},
    logger: () => {},
  });

  controller.codexRunning = true;
  controller.watcher = { pid: 999 };

  await controller.tick();

  assert.equal(stopCalls, 0);
  assert.equal(backgroundRefreshCalls, 1);
  assert.equal(controller.codexRunning, true);
  assert.deepEqual(controller.watcher, { pid: 999 });
});

test("AgentController re-syncs when Codex becomes visible again without a process restart", async () => {
  const states = [];
  let activationSyncCalls = 0;
  let watcherStarts = 0;
  const controller = new AgentController({
    detectCodexProcesses: async () => [{ pid: 101, name: "Codex", hasVisibleWindow: true }],
    performStartupSync: async () => ({ synced_repo_count: 0 }),
    performActivationSync: async () => {
      activationSyncCalls += 1;
      return { synced_repo_count: 1 };
    },
    performShutdownSync: async () => ({ synced_repo_count: 0 }),
    activateWatcher: async () => {
      watcherStarts += 1;
      return { pid: 1001 };
    },
    deactivateWatcher: async () => {},
    recordEvent: async () => {},
    writeState: async (payload) => {
      states.push(payload);
    },
    logger: () => {},
  });

  controller.codexRunning = true;
  controller.codexVisible = false;
  controller.watcher = { pid: 999 };

  await controller.tick();

  assert.equal(activationSyncCalls, 1);
  assert.equal(watcherStarts, 0);
  assert.equal(controller.codexRunning, true);
  assert.equal(controller.codexVisible, true);
  assert.deepEqual(controller.watcher, { pid: 999 });
  assert.equal(states.at(-1).phase, "watching");
  assert.deepEqual(states.at(-1).last_activation_sync, { synced_repo_count: 1 });
});

test("AgentController records hidden state when Codex loses visibility without stopping", async () => {
  const states = [];
  let shutdownSyncCalls = 0;
  let stopCalls = 0;

  const controller = new AgentController({
    detectCodexProcesses: async () => [{ pid: 101, name: "Codex", hasVisibleWindow: false }],
    performStartupSync: async () => ({ synced_repo_count: 0 }),
    performShutdownSync: async () => {
      shutdownSyncCalls += 1;
      return { synced_repo_count: 0 };
    },
    activateWatcher: async () => ({ pid: 999 }),
    deactivateWatcher: async () => {
      stopCalls += 1;
    },
    recordEvent: async () => {},
    writeState: async (payload) => {
      states.push(payload);
    },
    logger: () => {},
  });

  controller.codexRunning = true;
  controller.codexVisible = true;
  controller.watcher = { pid: 999 };

  await controller.tick();

  assert.equal(stopCalls, 0);
  assert.equal(shutdownSyncCalls, 0);
  assert.equal(controller.codexRunning, true);
  assert.equal(controller.codexVisible, false);
  assert.equal(states.at(-1).phase, "watching");
  assert.equal(states.at(-1).codex_visible, false);
});

test("AgentController does not immediately re-activate when post-sync visibility briefly drops", async () => {
  const states = [];
  let activationSyncCalls = 0;
  const detectorResults = [
    [{ pid: 101, name: "Codex", hasVisibleWindow: true }],
    [{ pid: 101, name: "Codex", hasVisibleWindow: false }],
    [{ pid: 101, name: "Codex", hasVisibleWindow: true }],
  ];

  const controller = new AgentController({
    detectCodexProcesses: async () => detectorResults.shift() || [],
    performStartupSync: async () => ({ synced_repo_count: 0 }),
    performActivationSync: async () => {
      activationSyncCalls += 1;
      return { synced_repo_count: 1 };
    },
    performShutdownSync: async () => ({ synced_repo_count: 0 }),
    activateWatcher: async () => ({ pid: 999 }),
    deactivateWatcher: async () => {},
    recordEvent: async () => {},
    writeState: async (payload) => {
      states.push(payload);
    },
    logger: () => {},
  });

  controller.codexRunning = true;
  controller.codexVisible = false;
  controller.watcher = { pid: 999 };

  await controller.tick();
  await controller.tick();

  assert.equal(activationSyncCalls, 1);
  assert.equal(controller.codexVisible, true);
  assert.equal(states.at(-1).phase, "watching");
});
