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
 * HomeView is lazy-loaded via React.lazy to code-split heavy dependencies
 * (recharts, @tanstack/react-table, @dnd-kit, zod) out of the initial bundle.
 *
 * @see {@link https://github.com/stevederico/skateboard|Skateboard Docs}
 */
import './assets/styles.css';
import { createSkateboardApp } from '@stevederico/skateboard-ui/App';
import Layout from '@stevederico/skateboard-ui/Layout';
import CommandMenu from './components/CommandMenu.jsx';
import constants from './constants.json';
import ProjectsView from './components/ProjectsView.jsx';
import SubmissionsView from './components/SubmissionsView.jsx';
import ProjectSettingsView from './components/ProjectSettingsView.jsx';
import ChangelogView from './components/ChangelogView.jsx';
import BlankView from './components/BlankView.jsx';

/**
 * App layout with global command menu overlay.
 *
 * Wraps the default skateboard-ui Layout and injects CommandMenu
 * so the Cmd+K shortcut is available on all authenticated routes.
 *
 * @returns {JSX.Element} Layout with command menu
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
 *
 * @type {Array<{path: string, element: JSX.Element}>}
 */
const appRoutes = [
  { path: 'projects', element: <ProjectsView /> },
  { path: 'submissions', element: <SubmissionsView /> },
  { path: 'changelog', element: <ChangelogView /> },
  { path: 'project-settings', element: <ProjectSettingsView /> }
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
 * @param {Object} config - App configuration
 * @param {Object} config.constants - App constants from constants.json
 * @param {Array} config.appRoutes - Route configuration array
 * @param {string} config.defaultRoute - Initial route path
 */
createSkateboardApp({
  constants,
  appRoutes,
  defaultRoute: 'projects',
  overrides: { layout: AppLayout }
});
