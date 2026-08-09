// Which plugins this instance has installed, as far as the server knows today.
//
// The dispatcher enforces a plugin's declarations against its manifest, so it
// needs to be able to find one — and it must find it WITHOUT running any plugin
// code, which is the whole reason the manifest is static data.
//
// This module is the one place a plugin id appears on the server path, and that
// is deliberate: the dispatcher takes the lookup as an argument, so the coupling
// lives here rather than in the request handling. Installing plugins at runtime
// means reading this set from the instance's install registry instead of a
// compiled-in list — that is issue #13, and it replaces this file's body without
// touching a single caller.
//
// Until then the installed set is „the plugins in this build", which is the
// truthful answer for a deploy that can only run what it shipped with.

import type { PluginManifest } from '../../src/pluginHost/manifest';
import { productRoadmapManifest } from '../../src/plugins/product-roadmap/manifest.ts';

const BUILT_IN: PluginManifest[] = [productRoadmapManifest];

/** Every manifest the server can enforce against. */
export function installedManifests(): PluginManifest[] {
  return BUILT_IN;
}

/** The manifest for one plugin id, or null when the instance has no such plugin. */
export function installedManifest(pluginId: string): PluginManifest | null {
  return BUILT_IN.find((m) => m.id === pluginId) ?? null;
}
