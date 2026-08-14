// Skip electron-builder's production dependency install in monorepo mode.
// That step re-runs npm in packages/desktop and can delete hoisted app-builder-bin on Windows.
module.exports = async function beforeBuild() {
  return false
}
