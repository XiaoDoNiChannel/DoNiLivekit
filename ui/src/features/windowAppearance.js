// Serialize native changes so rapid theme clicks always leave the last choice applied.
export function createWindowAppearance(setNativeTheme) {
  let queue = Promise.resolve();
  return theme => {
    queue = queue.catch(() => {}).then(() => setNativeTheme(theme));
    return queue;
  };
}
