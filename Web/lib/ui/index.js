// Entry point for the new UI ("next"). script.js loads this with a dynamic
// import only when <html data-ui="next">, so the legacy layout never
// downloads or parses any of it.
//
// Every module here is imported at the same ?v= token; bump them together
// (scripts/check-asset-versions.mjs fails the build if they drift).

import * as Motion from "./motion.js?v=2";
import * as Theme from "./theme.js?v=5";
import * as Tokens from "./tokens.js?v=1";
import * as Stage from "./stage.js?v=7";
import * as Views from "./views.js?v=3";
import * as CharactersView from "./views-characters.js?v=3";
import * as AscensionsView from "./views-ascensions.js?v=1";
import * as RelicsView from "./views-relics.js?v=4";
import * as CardsView from "./views-cards.js?v=4";
import * as RunsView from "./views-runs.js?v=3";
import * as CommunityView from "./views-community.js?v=1";
import * as EmptyView from "./views-empty.js?v=3";
import * as ShareCard from "./share-card.js?v=2";
import * as CardArt from "./card-art-hd.js?v=1";
import { initCharts, hideChartTip } from "./charts.js?v=2";
import { startLegacyLayering } from "./legacy-layer.js?v=1";
import { mountMobileNav } from "./mobile-nav.js?v=6";
import { initLookNotice } from "./look-notice.js?v=4";

export {
  Motion, Theme, Tokens, Stage, Views, hideChartTip,
  CharactersView, AscensionsView, RelicsView, CardsView, RunsView, CommunityView, EmptyView,
  ShareCard, CardArt,
};

/**
 * One-time setup for the new UI. Call once, early in boot, before the first
 * tab render.
 * @param {{
 *   stageTabs: ReadonlyArray<string>,
 *   track?: (name: string, params: Record<string, unknown>) => void,
 * }} deps
 */
export function bootUI(deps) {
  startLegacyLayering();
  Theme.initTheme({ track: deps.track });
  Theme.mountThemeButtons();
  mountMobileNav();
  Stage.ensureStageMounts(deps.stageTabs);
  Stage.renderStage({ hiLevel: -1, recent: [] });
  Motion.initMotion();
  initCharts();
  initLookNotice({ track: deps.track });
}
