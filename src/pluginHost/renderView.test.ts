// The host's side of rendering a plugin view.
//
// One rule, and it was found the hard way: a plugin renders into a DETACHED
// element and the host swaps it in when the call settles. `renderView` may be
// async — the first plugin built outside this repository awaits the host API
// before it can paint anything — and two overlapping repaints then both clear the
// section and both append, leaving the view rendered twice. An „idempotent"
// plugin cannot fix that for itself, because the interleaving is the host's.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { renderPluginViewInto } from './renderView';
import type { HostApi } from './hostApi';

/** Just enough DOM for the swap: children, a class, and createElement. */
function fakeElement(): any {
  const node: any = {
    className: '',
    children: [] as any[],
    ownerDocument: { createElement: () => fakeElement() },
    append(...nodes: any[]) {
      node.children.push(...nodes);
    },
    replaceChildren(...nodes: any[]) {
      node.children = [...nodes];
    },
  };
  return node;
}

const host = {} as HostApi;

describe('renderPluginViewInto', () => {
  test('a synchronous plugin ends up as exactly one child', () => {
    const section = fakeElement();
    const mod = {
      renderView(container: any) {
        container.append({ tag: 'painted' });
      },
    };
    renderPluginViewInto(section, 'demo', 'board', mod as never, host);
    assert.equal(section.children.length, 1);
    assert.deepEqual(section.children[0].children, [{ tag: 'painted' }]);
  });

  test('two overlapping async renders leave one view, not two', () => {
    // The regression this exists for.
    const section = fakeElement();
    const gates: Array<() => void> = [];
    const mod = {
      renderView(container: any, _viewId: string) {
        return new Promise<void>((resolve) => {
          gates.push(() => {
            container.append({ tag: 'painted' });
            resolve();
          });
        });
      },
    };
    renderPluginViewInto(section, 'demo', 'board', mod as never, host);
    renderPluginViewInto(section, 'demo', 'board', mod as never, host);
    assert.equal(section.children.length, 0, 'nothing is shown until a render settles');

    gates[0]();
    gates[1]();
    return Promise.resolve().then(() => {
      assert.equal(section.children.length, 1);
    });
  });

  test('a render that lost the race does not overwrite the newer one', async () => {
    const section = fakeElement();
    const gates: Array<() => void> = [];
    const paint = (mark: string) => ({
      renderView(container: any) {
        return new Promise<void>((resolve) => {
          gates.push(() => {
            container.append({ tag: mark });
            resolve();
          });
        });
      },
    });
    renderPluginViewInto(section, 'demo', 'board', paint('old') as never, host);
    renderPluginViewInto(section, 'demo', 'board', paint('new') as never, host);

    // The newer one finishes FIRST, then the stale one — the interleaving that a
    // „last write wins" swap would get wrong.
    gates[1]();
    await Promise.resolve();
    gates[0]();
    await Promise.resolve();

    assert.equal(section.children.length, 1);
    assert.deepEqual(section.children[0].children, [{ tag: 'new' }]);
  });

  test('a plugin that throws synchronously still swaps in what it managed to paint', () => {
    // The loader wraps the plugin's throw and puts a failure notice into the
    // container; showing that notice is the point, so the swap has to happen.
    const section = fakeElement();
    const mod = {
      renderView(container: any) {
        container.append({ tag: 'failure notice' });
        throw new Error('boom');
      },
    };
    renderPluginViewInto(section, 'demo', 'board', mod as never, host);
    assert.equal(section.children.length, 1);
    assert.deepEqual(section.children[0].children, [{ tag: 'failure notice' }]);
  });

  test('a rejected render is swapped in rather than leaving the section blank', async () => {
    const section = fakeElement();
    const mod = {
      renderView(container: any) {
        container.append({ tag: 'partial' });
        return Promise.reject(new Error('boom'));
      },
    };
    renderPluginViewInto(section, 'demo', 'board', mod as never, host);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(section.children.length, 1);
  });
});
