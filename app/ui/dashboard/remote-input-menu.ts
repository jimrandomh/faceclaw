import { remoteTokens, remoteInputStatus, remoteInterfaceSelection, selectRemoteInterface } from '../../remote/service';
import { PERMISSIONS, type Permission } from '../../remote/protocol';
import { isTunnelInterface } from '../../remote/listeners';
import { copyRemoteToken, remoteInterfaces } from '../../native/remote-input';
import { TextViewerLayer } from '../../apps/files/text-viewer';
import { ConfigSettingString, textSettingMenuItem } from '../dashboard-settings';
import { getDefaultSmallFont } from '../../graphics/ui-fonts';
import { drawRightValueMenuItem, type MenuItem } from '../menu';
import { type LayerContext } from '../layers';
import { openSettingsSubMenu } from './settings-panel';

const labels: Record<Permission, string> = { input: 'Provide input', text: 'Text to foreground window', assistant: 'Text to voice assistant' };
const nameSetting = new ConfigSettingString({ id: 'remoteInputNewName', storageKey: 'remoteInput.newName',
  label: 'Token name', defaultValue: 'My app', normalize: value => (value ?? '').slice(0, 80) });

function permissionItem(permission: Permission, get: () => Permission[], set: (values: Permission[]) => void): MenuItem {
  return { label: labels[permission], onSelect: ctx => {
    const current = get();
    set(current.includes(permission) ? current.filter(p => p !== permission) : [...current, permission]);
    ctx.actions.requestRender();
  }, render: ({ image, x, y, width }) => drawRightValueMenuItem(image, getDefaultSmallFont(), x, y, width,
    labels[permission], get().includes(permission) ? 'On' : 'Off') };
}
function showError(ctx: LayerContext, error: unknown): void {
  ctx.stack.push(new TextViewerLayer(error instanceof Error ? error.message : 'Could not update token.', 'Input tokens'));
}
function tokenDetails(ctx: LayerContext, id: string): void {
  const record = remoteTokens.list().find(r => r.id === id);
  if (!record) return;
  openSettingsSubMenu(ctx, record.name, [
    ...PERMISSIONS.map(p => permissionItem(p, () => remoteTokens.list().find(r => r.id === id)?.permissions ?? [],
      values => remoteTokens.permissions(id, values))),
    { label: 'Revoke token', onSelect: inner => openSettingsSubMenu(inner, `Revoke ${record.name}?`, [
      { label: 'Cancel', onSelect: c => { c.stack.pop(); } },
      { label: 'Revoke', onSelect: c => {
        remoteTokens.revoke(id);
        c.stack.pop(); c.stack.pop(); c.stack.pop();
        openTokens(c);
      } },
    ]) },
  ]);
}
function createToken(ctx: LayerContext): void {
  let permissions: Permission[] = ['input'];
  openSettingsSubMenu(ctx, 'Create input token', [
    textSettingMenuItem(nameSetting),
    ...PERMISSIONS.map(p => permissionItem(p, () => permissions, values => { permissions = values; })),
    { label: 'Generate token', onSelect: inner => {
      try {
        const { token } = remoteTokens.create(nameSetting.get(), permissions);
        inner.stack.pop(); inner.stack.pop();
        openTokens(inner);
        // The secret lives only in this temporary menu; it cannot be recovered after closing it.
        openSettingsSubMenu(inner, 'Save your token now', [
          { label: 'Copy token to phone clipboard', onSelect: c => {
            try { copyRemoteToken(token); c.stack.push(new TextViewerLayer('Token copied. Save it in the calling app or FACECLAW_TOKEN. The secret cannot be shown again after leaving this menu.', 'Copied')); }
            catch (error) { showError(c, error); }
          } },
          { label: 'Show token (only available now)', onSelect: c => c.stack.push(new TextViewerLayer(token, 'Input token')) },
          { label: 'Done', onSelect: c => { c.stack.pop(); } },
        ]);
      } catch (error) { showError(inner, error); }
    } },
  ]);
}
function interfaceMenu(ctx: LayerContext): void {
  const interfaces = remoteInterfaces().filter(isTunnelInterface);
  const names = [...new Set(interfaces.map(item => item.name))];
  const choices = [
    { value: 'tailscale', label: 'Localhost + Tailscale (auto)' },
    { value: 'localhost', label: 'Localhost / USB only' },
    ...names.map(name => ({ value: `interface:${name}`, label: `${name}: ${interfaces.filter(item => item.name === name).map(item => item.address).join(', ')}` })),
  ];
  openSettingsSubMenu(ctx, 'Listening interfaces', choices.map(choice => ({
    label: `${choice.label}${remoteInterfaceSelection() === choice.value ? ' *' : ''}`,
    onSelect: inner => { selectRemoteInterface(choice.value); inner.stack.pop(); },
  })));
}
function openTokens(ctx: LayerContext): void {
  openSettingsSubMenu(ctx, 'Input tokens', [
    { label: 'Create token', onSelect: createToken },
    { label: 'Listening interfaces', onSelect: interfaceMenu },
    { label: 'Connection information', onSelect: c => c.stack.push(new TextViewerLayer(
      `${remoteInputStatus()}\n\nAndroid USB: adb forward tcp:8791 tcp:8791\n\niOS USB: iproxy 8791 8791\n\nTailscale: use --host with the displayed tunnel IP. Listening interfaces lets you select a tunnel if auto detection fails. Wi-Fi/LAN addresses are never selected.\n\nUse scripts/faceclaw-input.cjs with FACECLAW_TOKEN set. Tokens grant only the selected permissions. Revoking a token takes effect on the next request. Text is blocked while the glasses are locked.`, 'Input API')) },
    ...remoteTokens.list().map(record => ({ label: record.name, onSelect: (c: LayerContext) => tokenDetails(c, record.id) })),
  ]);
}
export function remoteInputMenuItem(): MenuItem {
  return { label: 'Input tokens', description: 'Allow another app to provide ring/watch input, type into the foreground window, or send messages to the voice assistant. Create tokens with individual permissions and revoke them here.', onSelect: openTokens };
}
