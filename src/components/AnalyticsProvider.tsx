import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { getState } from '@stevederico/skateboard-ui/Context';
import type { User } from '@stevederico/skateboard-ui';
import { identifyUser, trackEvent } from '../util/analytics';
import useAdvancedAnalytics from '../util/useAdvancedAnalytics';

/** Props for the AnalyticsProvider wrapper. */
interface AnalyticsProviderProps {
  /** Child components (Router + App) */
  children?: ReactNode;
}

/**
 * Analytics wrapper component for Skateboard apps
 *
 * Sets up advanced Umami analytics (scroll, time, exit intent, sections, etc.)
 * and monitors auth state to identify users and track sign-in/sign-out events.
 * Pass as the `wrapper` prop to createSkateboardApp().
 *
 * @param props - Wrapper props
 * @param props.children - Child components (Router + App)
 */
export default function AnalyticsProvider({ children }: AnalyticsProviderProps) {
  useAdvancedAnalytics();

  const { state } = getState();
  const previousUserRef = useRef<User | null>(null);

  useEffect(() => {
    const currentUser = state.user;
    const previousUser = previousUserRef.current;

    if (currentUser && !previousUser) {
      identifyUser(String(currentUser.id ?? ''), {
        email: currentUser.email,
        name: currentUser.name,
        subscription: currentUser.subscription?.status || 'free'
      });
      trackEvent('signin-completed');
    }

    if (!currentUser && previousUser) {
      trackEvent('signout');
    }

    previousUserRef.current = currentUser;
  }, [state.user]);

  return <>{children}</>;
}
