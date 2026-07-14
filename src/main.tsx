/**
 * Application entry point using Skateboard Application Shell Architecture
 *
 * Configures routing and initializes app with skateboard-ui framework.
 * The shell (skateboard-ui) provides:
 * - Routing system with React Router v7
 * - Context/state management
 * - Authentication flow
 * - Common UI components (Header, Footer, UpgradeSheet)
 * - Utility functions (apiRequest, usage tracking)
 *
 * This file only defines:
 * - Custom view components
 * - Route configuration
 * - App constants
 *
 * @see {@link https://github.com/stevederico/skateboard|Skateboard Docs}
 */
import './assets/styles.css';
import { createSkateboardApp } from '@stevederico/skateboard-ui/App';
import type { AppRoute } from '@stevederico/skateboard-ui/App';
import Layout from '@stevederico/skateboard-ui/Layout';
import CommandMenu from './components/CommandMenu';
import baseConstants from './constants.json';
import { applyPublicConfigOverrides } from './util/publicConfig';
import ProjectsView from './components/ProjectsView';
import SubmissionsView from './components/SubmissionsView';
import ChangelogView from './components/ChangelogView';

/** constants.json defaults + COMPANY_* / FRONTEND_URL overrides from the build env. */
const constants = applyPublicConfigOverrides(baseConstants);

/**
 * App layout with global command menu overlay.
 *
 * Wraps the default skateboard-ui Layout and injects CommandMenu
 * so the Cmd+K shortcut is available on all authenticated routes.
 *
 * @returns Layout with command menu
 */
function AppLayout() {
  return (
    <>
      <CommandMenu />
      <Layout />
    </>
  );
}

/**
 * Application route configuration
 *
 * Maps route paths to view components. Routes are relative to root (no leading slash).
 * The shell handles route registration, navigation, and layout.
 */
const appRoutes: AppRoute[] = [
  { path: 'apps', element: <ProjectsView /> },
  { path: 'submissions', element: <SubmissionsView /> },
  { path: 'changelog', element: <ChangelogView /> }
];

/**
 * Initialize and mount Skateboard app
 *
 * Creates React root, configures router, initializes context/state,
 * and renders app shell. Automatically handles:
 * - User authentication state
 * - Protected routes
 * - Navigation setup
 * - Footer with app info
 *
 * @param config - App configuration
 * @param config.constants - App constants from constants.json
 * @param config.appRoutes - Route configuration array
 * @param config.defaultRoute - Initial route path
 */
createSkateboardApp({
  constants,
  appRoutes,
  defaultRoute: 'apps',
  overrides: { layout: AppLayout }
});
