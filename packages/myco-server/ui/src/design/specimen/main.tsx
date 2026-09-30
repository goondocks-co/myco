import React from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { applyAppearance } from '../../lib/appearance-apply';
import { APPEARANCE_DENSITIES, APPEARANCE_MODES, APPEARANCE_THEMES, DEFAULT_APPEARANCE, type AppearanceValues } from '../../lib/appearance-values';
import { Specimen } from './Specimen';
import '../../index.css';

/** Reads `?theme=`, `?mode=` and `?density=` so a screen check can shoot every combination. */
function appearanceFromQuery(): AppearanceValues {
  const params = new URLSearchParams(window.location.search);
  const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const value = params.get(key);
    return allowed.includes(value as T) ? (value as T) : fallback;
  };
  return {
    ...DEFAULT_APPEARANCE,
    theme: pick('theme', APPEARANCE_THEMES, DEFAULT_APPEARANCE.theme),
    mode: pick('mode', APPEARANCE_MODES, DEFAULT_APPEARANCE.mode),
    density: pick('density', APPEARANCE_DENSITIES, DEFAULT_APPEARANCE.density),
  };
}

applyAppearance(appearanceFromQuery());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MemoryRouter>
      <Specimen />
    </MemoryRouter>
  </React.StrictMode>,
);
