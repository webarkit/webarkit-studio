/**
 * Assets panel: uploads files into the project's AssetStore, lists them, and
 * keeps one <datalist id="assets-<kind>"> per asset kind up to date, which the
 * node editor attaches to the params marked `asset` (suggestions of matching
 * uploads, as asset://<id>/<name> references).
 */
import { assetRef } from '../core/assets';
import { assetSize, type AssetStore } from '../assets/asset-store';
import type { AssetKind } from '../nodes/catalog';

const KINDS: Record<AssetKind, string> = { nftDataset: 'NFT dataset', model: 'model', file: 'file' };
const ACCEPT = '.iset,.fset,.fset3,.glb,.gltf,image/*,video/*,.dat';

const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** `inUse(id)`: whether the current graph references the asset (asked before removing it). */
export function mountAssetsPanel(
  container: HTMLElement,
  store: AssetStore,
  log: (msg: string) => void,
  inUse: (id: string) => boolean = () => false,
): void {
  container.innerHTML = `
    <h3>assets</h3>
    <button class="asset-upload" title="Images, videos, glTF / GLB models and NFT datasets (select the .iset, .fset and .fset3 files together)">Upload…</button>
    <input class="asset-input" type="file" multiple hidden accept="${ACCEPT}" />
    <ul class="asset-list"></ul>`;
  const input = container.querySelector<HTMLInputElement>('.asset-input')!;
  const list = container.querySelector<HTMLUListElement>('.asset-list')!;
  container.querySelector<HTMLButtonElement>('.asset-upload')!.onclick = () => input.click();
  input.onchange = async () => {
    try {
      for (const a of await store.add([...(input.files ?? [])])) log(`+ asset ${a.name} (${KINDS[a.kind]})`);
    } catch (err) {
      log(`✗ ${(err as Error).message}`);
    }
    input.value = '';
  };

  const datalists = Object.fromEntries(
    (Object.keys(KINDS) as AssetKind[]).map((kind) => {
      const dl = document.getElementById(`assets-${kind}`) ?? document.body.appendChild(Object.assign(document.createElement('datalist'), { id: `assets-${kind}` }));
      return [kind, dl];
    }),
  ) as Record<AssetKind, HTMLElement>;

  const render = () => {
    list.replaceChildren(
      ...store.list().map((asset) => {
        const ref = assetRef(asset.id, asset.name);
        const li = document.createElement('li');
        li.className = 'asset';
        li.dataset.ref = ref;
        li.dataset.kind = asset.kind;
        li.title = `${ref}\nSet it on a param (the field suggests uploads of its kind).`;
        li.innerHTML = `<span class="asset-name"></span><small>${KINDS[asset.kind]} · ${formatSize(assetSize(asset))}</small>`;
        li.querySelector('.asset-name')!.textContent = asset.name;
        const remove = Object.assign(document.createElement('button'), { className: 'asset-remove', textContent: '×', title: 'Remove from the project' });
        remove.onclick = () => {
          if (inUse(asset.id) && !confirm(`The graph uses "${asset.name}". Remove it from the project anyway?`)) return;
          store.remove(asset.id).then(
            () => log(`- asset ${asset.name}`),
            (err: Error) => log(`✗ cannot remove ${asset.name}: ${err.message}`),
          );
        };
        li.appendChild(remove);
        return li;
      }),
    );
    for (const [kind, dl] of Object.entries(datalists) as Array<[AssetKind, HTMLElement]>) {
      dl.replaceChildren(
        ...store.list(kind).map((a) => Object.assign(document.createElement('option'), { value: assetRef(a.id, a.name), label: a.name })),
      );
    }
  };
  store.onChange(render);
  render();
}
