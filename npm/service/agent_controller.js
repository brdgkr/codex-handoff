class AgentController {
  constructor({
    detectCodexProcesses,
    performStartupSync,
    performActivationSync,
    performBackgroundRefresh,
    performShutdownSync,
    activateWatcher,
    deactivateWatcher,
    recordEvent,
    writeState,
    logger,
  }) {
    this.detectCodexProcesses = detectCodexProcesses;
    this.performStartupSync = performStartupSync;
    this.performActivationSync = performActivationSync || performStartupSync;
    this.performBackgroundRefresh = performBackgroundRefresh || (async () => ({ skipped: true }));
    this.performShutdownSync = performShutdownSync || (async () => ({ skipped: true }));
    this.activateWatcher = activateWatcher;
    this.deactivateWatcher = deactivateWatcher;
    this.recordEvent = recordEvent || (async () => {});
    this.writeState = writeState;
    this.logger = logger || (() => {});
    this.codexRunning = false;
    this.codexVisible = false;
    this.busy = false;
    this.watcher = null;
  }

  async initialize() {
    const codexProcesses = await this.detectCodexProcesses();
    this.codexRunning = false;
    this.codexVisible = hasVisibleCodexWindow(codexProcesses);
    await this.enterIdleState({
      phase: "idle",
      codex_processes: codexProcesses,
      watcher: this.watcher,
      codex_running: codexProcesses.length > 0,
      codex_visible: this.codexVisible,
    });
  }

  async tick() {
    if (this.busy) {
      return;
    }
    const codexProcesses = await this.detectCodexProcesses();
    const running = codexProcesses.length > 0;
    const visible = hasVisibleCodexWindow(codexProcesses);
    if (running && !this.codexRunning) {
      this.busy = true;
      try {
        await this.handleCodexStart(codexProcesses, visible);
      } finally {
        this.busy = false;
      }
      return;
    }
    if (!running && this.codexRunning) {
      this.busy = true;
      try {
        await this.handleCodexStop();
      } finally {
        this.busy = false;
      }
      return;
    }
    if (running && visible && !this.codexVisible) {
      this.busy = true;
      try {
        await this.handleCodexActivate(codexProcesses);
      } finally {
        this.busy = false;
      }
      return;
    }
    if (running && !visible && this.codexVisible) {
      this.busy = true;
      try {
        await this.handleCodexHidden(codexProcesses);
      } finally {
        this.busy = false;
      }
      return;
    }
    await this.handleSteadyState(codexProcesses, running, visible);
  }

  async handleCodexStart(codexProcesses, visible = hasVisibleCodexWindow(codexProcesses)) {
    this.logger(`Codex detected (${codexProcesses.length} process(es))`);
    await this.recordEvent("codex_detected", { process_count: codexProcesses.length });
    this.codexRunning = true;
    this.codexVisible = visible;
    await this.enterSyncingState({
      phase: "syncing",
      codex_processes: codexProcesses,
      watcher: this.watcher,
      codex_running: true,
      codex_visible: visible,
    });
    this.logger("starting initial sync");
    const syncResult = await this.performStartupSync();
    this.logger("initial sync finished");
    const codexProcessesAfterSync = await this.detectCodexProcesses();
    if (codexProcessesAfterSync.length > 0) {
      this.codexVisible = settleVisibleAfterSync(codexProcessesAfterSync, this.codexVisible);
      this.watcher = await this.startWatching();
      await this.enterWatchingState({
        phase: "watching",
        codex_processes: codexProcessesAfterSync,
        watcher: this.watcher,
        codex_running: true,
        codex_visible: this.codexVisible,
        last_sync: syncResult,
      });
      return;
    }
    this.codexRunning = false;
    this.codexVisible = false;
    await this.enterIdleState({
      phase: "idle",
      codex_processes: [],
      watcher: this.watcher,
      codex_running: false,
      codex_visible: false,
      last_sync: syncResult,
    });
  }

  async handleCodexStop() {
    this.logger("Codex no longer detected");
    await this.recordEvent("codex_stopped", {});
    if (this.watcher) {
      await this.stopWatching();
      this.watcher = null;
    }
    let shutdownSync = null;
    await this.enterSyncingState({
      phase: "finalizing",
      codex_processes: [],
      watcher: null,
      codex_running: false,
      codex_visible: false,
    });
    try {
      this.logger("starting shutdown sync");
      shutdownSync = await this.performShutdownSync();
      this.logger("shutdown sync finished");
      await this.recordEvent("shutdown_sync_completed", {
        synced_repo_count: shutdownSync?.synced_repo_count || 0,
        error_count: Array.isArray(shutdownSync?.errors) ? shutdownSync.errors.length : 0,
      });
    } catch (error) {
      shutdownSync = { error: error.message };
      this.logger(`shutdown sync error: ${error.stack || error.message}`);
      await this.recordEvent("shutdown_sync_error", { error: error.message });
    }
    this.codexRunning = false;
    this.codexVisible = false;
    await this.enterIdleState({
      phase: "idle",
      codex_processes: [],
      watcher: null,
      codex_running: false,
      codex_visible: false,
      last_shutdown_sync: shutdownSync,
    });
  }

  async handleCodexActivate(codexProcesses) {
    this.logger(`Codex activated (${codexProcesses.length} process(es))`);
    await this.recordEvent("codex_activated", { process_count: codexProcesses.length });
    this.codexVisible = true;
    await this.enterSyncingState({
      phase: "resyncing",
      codex_processes: codexProcesses,
      watcher: this.watcher,
      codex_running: true,
      codex_visible: true,
    });
    this.logger("starting activation sync");
    const syncResult = await this.performActivationSync();
    this.logger("activation sync finished");
    const codexProcessesAfterSync = await this.detectCodexProcesses();
    if (codexProcessesAfterSync.length === 0) {
      if (this.watcher) {
        await this.stopWatching();
        this.watcher = null;
      }
      this.codexRunning = false;
      this.codexVisible = false;
      await this.enterIdleState({
        phase: "idle",
        codex_processes: [],
        watcher: null,
        codex_running: false,
        codex_visible: false,
        last_activation_sync: syncResult,
      });
      return;
    }
    this.codexVisible = settleVisibleAfterSync(codexProcessesAfterSync, this.codexVisible);
    if (!this.watcher) {
      this.watcher = await this.startWatching();
    }
    await this.enterWatchingState({
      phase: "watching",
      codex_processes: codexProcessesAfterSync,
      watcher: this.watcher,
      codex_running: true,
      codex_visible: this.codexVisible,
      last_activation_sync: syncResult,
    });
  }

  async handleCodexHidden(codexProcesses) {
    this.logger("Codex hidden while process remains running");
    await this.recordEvent("codex_hidden", { process_count: codexProcesses.length });
    this.codexVisible = false;
    if (this.watcher) {
      await this.enterWatchingState({
        phase: "watching",
        codex_processes: codexProcesses,
        watcher: this.watcher,
        codex_running: true,
        codex_visible: false,
      });
      return;
    }
    await this.enterIdleState({
      phase: "idle",
      codex_processes: codexProcesses,
      watcher: null,
      codex_running: true,
      codex_visible: false,
    });
  }

  async handleSteadyState(codexProcesses, running, visible = hasVisibleCodexWindow(codexProcesses)) {
    this.codexVisible = visible;
    if (running && this.watcher) {
      await this.enterWatchingState({
        phase: "watching",
        codex_processes: codexProcesses,
        watcher: this.watcher,
        codex_running: true,
        codex_visible: visible,
      });
      await this.performBackgroundRefresh();
      return;
    }
    await this.enterIdleState({
      phase: "idle",
      codex_processes: codexProcesses,
      watcher: this.watcher,
      codex_running: running,
      codex_visible: visible,
    });
    await this.performBackgroundRefresh();
  }

  async startWatching() {
    return this.activateWatcher();
  }

  async stopWatching() {
    return this.deactivateWatcher();
  }

  async enterIdleState(payload) {
    await this.writeState(payload);
  }

  async enterSyncingState(payload) {
    await this.writeState(payload);
  }

  async enterWatchingState(payload) {
    await this.writeState(payload);
  }
}

function hasVisibleCodexWindow(codexProcesses) {
  const processes = Array.isArray(codexProcesses) ? codexProcesses : [];
  if (processes.length === 0) {
    return false;
  }
  if (processes.some((item) => item?.hasVisibleWindow === true)) {
    return true;
  }
  if (processes.every((item) => item?.hasVisibleWindow === false)) {
    return false;
  }
  return true;
}

function settleVisibleAfterSync(codexProcesses, previousVisible) {
  const visible = hasVisibleCodexWindow(codexProcesses);
  if (!visible && previousVisible) {
    return true;
  }
  return visible;
}

module.exports = {
  AgentController,
  hasVisibleCodexWindow,
  settleVisibleAfterSync,
};
