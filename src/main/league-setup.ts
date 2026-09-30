import type { ReviewLibrary } from '../library/library';
import type { LeagueDiscovery } from '../platform/discovery';
import { inspectLeagueInstallation } from '../platform/installation';
import type { LeagueInstallation, SetupView } from '../shared/setup';
import { ConfigEditError, editRequest, type ConfigEditRequest, type ConfigEdits, type ConfigEditResult } from '../platform/config-edit';
import { PreferenceEdits } from './preference-edits';

export class LeagueSetup {
  private view: SetupView = { searching: false, installations: [], warnings: [] };
  private generation = 0;
  private abort?: AbortController;
  private pendingElevation?: ConfigEditRequest;
  constructor(private readonly discovery: LeagueDiscovery, library: ReviewLibrary, private readonly changed: () => void,
    private readonly inspect = inspectLeagueInstallation, private readonly edits?: ConfigEdits, private readonly preferences = new PreferenceEdits(library)) {}
  snapshot(): SetupView { return structuredClone(this.view); }
  close(): void { this.generation++; this.abort?.abort(); }
  async refresh(): Promise<void> {
    if (this.view.editing) throw new Error('Wait for the configuration edit to finish.');
    this.pendingElevation = undefined; this.view.needsElevation = undefined;
    this.abort?.abort(); const abort = this.abort = new AbortController(), generation = ++this.generation;
    this.view.searching = true; this.view.error = undefined; this.changed();
    const selected = this.preferences.settings().selectedInstallation;
    try {
      let report;
      try { report = await this.discovery.discover(abort.signal); }
      catch (error) { report = { roots: [], warnings: [error instanceof Error ? error.message : String(error)] }; }
      if (abort.signal.aborted || generation !== this.generation) return;
      const roots = [...new Set([...(selected ? [selected] : []), ...report.roots])].slice(0, 33);
      const found = await Promise.all(roots.map(async root => { try { return await this.inspect(root); } catch (error) {
        if (root === selected) report.warnings.push(error instanceof Error ? error.message : String(error));
        return undefined;
      } }));
      if (abort.signal.aborted || generation !== this.generation) return;
      const unique = new Map(found.filter((value): value is LeagueInstallation => !!value).map(value => [value.root, value]));
      this.view = { searching: false, installations: [...unique.values()], warnings: report.warnings,
        selectedRoot: selected && unique.has(selected) ? selected : unique.size === 1 ? unique.keys().next().value : undefined };
      this.changed();
    } finally { if (generation === this.generation) { this.view.searching = false; this.changed(); } }
  }
  async select(folder: string): Promise<void> {
    if (this.view.editing) throw new Error('Wait for the configuration edit to finish.');
    this.pendingElevation = undefined; this.view.needsElevation = undefined;
    this.view.message = undefined;
    this.close(); this.view.searching = false;
    try {
      const installation = await this.inspect(folder);
      this.view.installations = [...this.view.installations.filter(item => item.root !== installation.root), installation];
      this.view.selectedRoot = installation.root;
      this.view.error = undefined;
      await this.preferences.setting('selectedInstallation', installation.root);
    } catch (error) { this.view.error = error instanceof Error ? error.message : String(error); throw error; }
    finally { this.changed(); }
  }
  async enable(path: string): Promise<void> { await this.change(this.request(path, 'enable')); }
  async restore(path: string, backupId: string): Promise<void> { await this.change(this.request(path, 'restore', backupId)); }
  async approveElevation(): Promise<void> {
    const request = this.pendingElevation;
    if (!request || this.view.selectedRoot !== request.root) throw new Error('Enable or restore the selected config first to check whether Windows permission is needed.');
    await this.change(request, true);
  }
  private request(path: string, action: 'enable' | 'restore', backupId?: string): ConfigEditRequest {
    const installation = this.view.installations.find(item => item.root === this.view.selectedRoot);
    const config = installation?.configs.find(item => item.path === path);
    if (!installation || !config?.sha256) throw new Error('Select an installation and refresh its readable configuration first.');
    if (action === 'enable' && config.inspection.state !== 'disabled' && config.inspection.state !== 'enabled') throw new Error('Resolve ambiguous configuration using the manual instructions before enabling the replay connection.');
    if (action === 'restore' && !config.backups?.some(backup => backup.id === backupId && backup.canRestore)) throw new Error('This backup cannot be restored over the current configuration. Refresh setup or use it for manual recovery.');
    return editRequest(installation.root, path, config.sha256, action, backupId);
  }
  private async change(request: ConfigEditRequest, elevated = false): Promise<void> {
    if (!this.edits) throw new Error('Automatic configuration editing is unavailable. Use the manual instructions.');
    if (this.view.editing) throw new Error('Wait for the configuration edit to finish.');
    this.close(); this.view.searching = false;
    this.view.editing = true; this.view.error = undefined; this.view.message = undefined;
    this.pendingElevation = undefined; this.view.needsElevation = undefined; this.changed();
    let result: ConfigEditResult | undefined;
    try {
      result = await this.edits.run(request, elevated);
      this.view.message = request.action === 'enable' ? 'Replay API enabled. Restart the replay in League to connect.' : 'Previous configuration restored. Restart the replay for this change to take effect.';
      if (result.backup) this.view.message += ` Original bytes were saved at ${result.backup.path}.`;
    } catch (error) {
      this.view.error = error instanceof Error ? error.message : String(error);
      if (error instanceof ConfigEditError && error.code === 'permission' && !elevated) {
        this.pendingElevation = request;
        const installation = this.view.installations.find(item => item.root === request.root);
        const config = installation?.configs.find(item => item.sha256 === request.expectedSha256 && item.path.replaceAll('\\', '/').endsWith(`/${request.relative}`));
        if (config) this.view.needsElevation = { path: config.path, action: request.action };
      }
      throw error;
    } finally {
      try {
        const inspected = await this.inspect(request.root);
        this.view.installations = [...this.view.installations.filter(item => item.root !== inspected.root), inspected];
        if (result && !inspected.configs.some(config => config.sha256 === result!.afterSha256 && config.path.replaceAll('\\', '/').endsWith(`/${request.relative}`))) this.view.message = 'The edit finished, but the configuration changed again. Close League and refresh setup before retrying.';
      } catch { this.view.error = `${this.view.error ?? 'The edit finished.'} Configuration could not be inspected afterward. Refresh setup and check its backup.`; }
      this.view.editing = false; this.changed();
    }
  }
}
