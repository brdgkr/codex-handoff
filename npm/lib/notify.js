const { spawnSync } = require("node:child_process");
const process = require("node:process");

const { withHiddenWindows } = require("./child-process");

function notificationPlatform() {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "unsupported";
}

function notify({ title, message }) {
  const platform = notificationPlatform();
  if (platform === "windows") {
    return notifyWindows({ title, message });
  }
  if (platform === "macos") {
    return notifyMacos({ title, message });
  }
  return {
    delivered: false,
    platform,
    error: "Unsupported platform.",
  };
}

function notifyWindows({ title, message }) {
  const script = buildWindowsToastScript(title, message);
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    withHiddenWindows({ encoding: "utf8" }),
  );
  return {
    delivered: result.status === 0,
    platform: "windows",
    error: result.status === 0 ? null : (result.stderr?.trim() || result.stdout?.trim() || "Failed to show toast notification."),
  };
}

function notifyMacos({ title, message }) {
  const result = spawnSync(
    "osascript",
    ["-e", `display notification "${escapeAppleScriptString(message)}" with title "${escapeAppleScriptString(title)}"`],
    { encoding: "utf8" },
  );
  return {
    delivered: result.status === 0,
    platform: "macos",
    error: result.status === 0 ? null : (result.stderr?.trim() || result.stdout?.trim() || "Failed to show macOS notification."),
  };
}

function buildWindowsToastScript(title, message) {
  const safeTitle = escapePowerShellString(title);
  const safeMessage = escapePowerShellString(message);
  return [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null",
    `$title = '${safeTitle}'`,
    `$message = '${safeMessage}'`,
    "$titleEsc = [System.Security.SecurityElement]::Escape($title)",
    "$messageEsc = [System.Security.SecurityElement]::Escape($message)",
    "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
    "$xml.LoadXml(\"<toast><visual><binding template='ToastText02'><text id='1'>$titleEsc</text><text id='2'>$messageEsc</text></binding></visual></toast>\")",
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
    "$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('codex-handoff')",
    "$notifier.Show($toast)",
  ].join("; ");
}

function escapePowerShellString(value) {
  return String(value || "").replace(/'/g, "''");
}

function escapeAppleScriptString(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

module.exports = {
  notify,
  notificationPlatform,
};
