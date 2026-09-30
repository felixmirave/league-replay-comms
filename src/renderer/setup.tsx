import type { SetupView } from '../shared/setup';
import type { UserCommand } from '../shared/protocol';

export function SetupPanel({ setup, connected, disabled, command }: { setup?: SetupView; connected: boolean; disabled: boolean; command(value: UserCommand): Promise<void> }) {
  if (!setup) return null;
  const selected = setup.installations.find(installation => installation.root === setup.selectedRoot);
  const state = selected?.configs.length === 1 ? selected.configs[0]!.inspection.state : undefined;
  const label = setup.editing ? 'Updating configuration…' : setup.searching ? 'Checking installation…' : state === 'enabled' ? 'Enabled in config' : state === 'disabled' ? 'Disabled in config' : selected ? 'Check configuration' : 'Select installation';
  disabled ||= !!setup.editing;
  return <details className="panel setup-panel">
    <summary>Replay connection setup · {label}</summary>
    <p>{connected ? 'The replay viewer is connected.' : 'Waiting for the replay viewer. Configuration and the running connection are checked separately.'}</p>
    {setup.error && <p className="error" role="alert">{setup.error}</p>}
    {setup.message && <p className="notice" role="status">{setup.message}</p>}
    {setup.needsElevation && <div className="notice"><p>Windows permission is needed to {setup.needsElevation.action === 'enable' ? 'enable Replay API access in' : 'restore'} {setup.needsElevation.path}. Only the configuration helper will request elevated permission.</p><button disabled={disabled} onClick={() => void command({ type: 'setup-elevate' })}>Allow Windows permission</button></div>}
    {setup.warnings.map(warning => <p className="notice" key={warning}>{warning}</p>)}
    <div className="row"><button disabled={disabled || setup.searching} onClick={() => void command({ type: 'setup-refresh' })}>Refresh setup</button><button disabled={disabled} onClick={() => void command({ type: 'setup-choose-folder' })}>Choose League folder</button></div>
    {!!setup.installations.length && <label>League installation<select disabled={disabled} value={setup.selectedRoot ?? ''} onChange={event => { if (event.target.value) void command({ type: 'setup-select', root: event.target.value }); }}><option value="" disabled>Choose an installation</option>{setup.installations.map(installation => <option key={installation.root} value={installation.root}>{installation.root}</option>)}</select></label>}
    {selected && <>
      {selected.configs.length > 1 && <p className="notice">Several configuration files exist in this installation. Verify which one this League client uses before editing.</p>}
      {selected.configs.map(config => <div key={config.path}>
        <p className="filename">{config.path}</p>
        <p>{config.inspection.state === 'enabled' ? 'EnableReplayApi is set to 1. Open or restart the replay to connect.' : config.inspection.state === 'disabled' ? 'Replay API access is not enabled in this file.' : config.inspection.reason}</p>
        {config.inspection.state === 'disabled' && <p>Enable replay connection sets <code>EnableReplayApi=1</code> under <code>[General]</code> in this file and saves a backup first.</p>}
        {config.inspection.state === 'disabled' && <button disabled={disabled} onClick={() => void command({ type: 'setup-enable', path: config.path })}>Enable replay connection</button>}
        <button disabled={disabled || (config.inspection.state === 'missing' && !config.backups?.length)} onClick={() => void command({ type: 'setup-open-config', path: config.path })}>Open config folder</button>
        {!!config.backups?.length && <details><summary>Configuration backups ({config.backups.length})</summary>{config.backups.map(backup => <div key={backup.id}><p className="filename">{backup.path}</p><p>{new Date(backup.createdAt).toLocaleString()}{backup.reason ? ` · ${backup.reason}` : ''}</p><button disabled={disabled || !backup.canRestore} onClick={() => void command({ type: 'setup-restore', path: config.path, backupId: backup.id })}>Restore previous config</button></div>)}</details>}
      </div>)}
      <p>To enable it manually, set <code>EnableReplayApi=1</code> in the <code>[General]</code> section of the existing <code>game.cfg</code>, save, and restart the replay. Refresh setup afterward.</p>
    </>}
  </details>;
}
