// @ts-check
// Node identity for Pixi 8 — the layer that makes everything else addressable.
//
// WHY THIS EXISTS (all three measured on pixi 8.14.1, see docs/ENGINES.md §3):
//   • `constructor.name` is DEAD. A production build mangles it to `Z`/`I`/`ke`/`ia`; even a Vite
//     DEV server renames Pixi's own classes (`_Sprite`, `_TilingSprite2`). Never read it.
//   • `label` is a DECOY. Pixi's own constructors set it as a default (Sprite.js → `label:"Sprite"`,
//     Graphics.js → `label:"Graphics"`, …), so ~half a tree looks "named" while carrying zero
//     identity. Real, game-set labels are rare and must be separated from these defaults.
//   • `renderPipeId` SURVIVES minification (it's a string literal on the render pipe), which makes
//     duck-typing the only reliable identity — the same conclusion the official PixiJS devtools
//     reached in its getPixiType.ts.
// So: type comes from renderPipeId + structural probes, and a node's NAME is its game-set label if
// it has a real one, else its type. Ref paths then disambiguate with the existing `[i]` machinery.

// Every `label: "…"` default Pixi's own display classes set on themselves (verified by grepping
// pixi.js@8 lib/scene). A label matching one of these is Pixi's, not the game's → not identity.
const PIXI_DEFAULT_LABELS = new Set([
  'Sprite', 'Graphics', 'TilingSprite', 'Mesh', 'NineSliceSprite', 'ParticleContainer', 'RenderContainer',
]);

// renderPipeId → copse type name. The full set emitted by pixi 8's scene/ (verified against the
// shipped lib): bitmapText, customRender, graphics, htmlText, mesh, nineSliceSprite, particle,
// renderGroup, sprite, text, tilingSprite.
const PIPE_TYPES = {
  sprite: 'Sprite',
  text: 'Text',
  bitmapText: 'BitmapText',
  htmlText: 'HTMLText',
  graphics: 'Graphics',
  mesh: 'Mesh',
  tilingSprite: 'TilingSprite',
  nineSliceSprite: 'NineSliceSprite',
  particle: 'ParticleContainer',
  customRender: 'RenderContainer',
};

/**
 * A node's type, duck-typed so it survives minification. Never `instanceof`, never `constructor.name`.
 * @param {any} n @returns {string}
 */
export function pixiType(n) {
  if (!n || typeof n !== 'object') return 'Unknown';
  const byPipe = PIPE_TYPES[n.renderPipeId];
  if (byPipe) {
    // NineSliceSprite reports renderPipeId 'nineSliceSprite' on 8.x, but guard the structural
    // fallback too (the devtools does) in case a build routes it through the sprite pipe.
    if (byPipe === 'Sprite' && (n._leftWidth !== undefined || n._rightWidth !== undefined)) return 'NineSliceSprite';
    return byPipe;
  }
  // Containers have no renderPipeId. A few still identify structurally.
  if (n.particleChildren) return 'ParticleContainer';
  if (Array.isArray(n.children)) return 'Container';
  return 'Unknown';
}

/**
 * The game's OWN label, or null when the label is absent / is one of Pixi's constructor defaults.
 * This is the only naming signal that carries real identity, and most games set none.
 * @param {any} n @returns {string|null}
 */
export function gameLabel(n) {
  const l = n && n.label;
  if (typeof l !== 'string' || l === '') return null;
  if (PIXI_DEFAULT_LABELS.has(l)) return null;    // Pixi set it, not the game
  return l;
}

/**
 * A node's NAME for path addressing: the game's label when it has a real one, else the type.
 * Yields refs like `hud/Container[2]/Text[0]` — positional below the first game-named ancestor,
 * which is why the Pixi lane is `find`-first (docs/ENGINES.md §3).
 * @param {any} n @returns {string}
 */
export const pixiName = (n) => gameLabel(n) || pixiType(n);

/**
 * Is this node's own pixels a Text of some kind (Text / BitmapText / HTMLText)? The basis for the
 * `Label` pseudo-component, which is what makes core's snapshot/diff `labelChanged` work unchanged.
 * @param {any} n
 */
export const isText = (n) => {
  const t = pixiType(n);
  return t === 'Text' || t === 'BitmapText' || t === 'HTMLText';
};

/** Node types whose pixels change frame-to-frame — masked out of a visual anchor (see visual.js). */
export const DEFAULT_DYNAMIC = ['Text', 'BitmapText', 'HTMLText', 'ParticleContainer', 'AnimatedSprite'];
