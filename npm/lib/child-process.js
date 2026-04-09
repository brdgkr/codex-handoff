function withHiddenWindows(options = {}) {
  if (process.platform !== "win32") {
    return options;
  }
  return {
    ...options,
    windowsHide: true,
  };
}

module.exports = {
  withHiddenWindows,
};
