/**
 * Advanced Umami analytics hook for Skateboard apps
 *
 * Sets up passive tracking for scroll depth, time on page, exit intent,
 * section visibility, page load performance, JS errors, and text copy events.
 * Detects route changes by intercepting history.pushState/replaceState
 * (wrapper renders outside Router, so useLocation is unavailable).
 *
 * All tracking is disabled on localhost via isLocal() guard.
 */
import { useEffect, useRef } from 'react';
import { trackEvent, trackPageView } from './analytics';

/** True if running on localhost */
const isLocal = (): boolean => ['localhost', '127.0.0.1'].includes(window.location.hostname);

/**
 * Hook that sets up all passive analytics trackers.
 * Call once at app root level (e.g., in AnalyticsProvider wrapper).
 * Automatically cleans up all listeners on unmount.
 */
export default function useAdvancedAnalytics(): void {
  const scrollDepthsRef = useRef<Set<number>>(new Set());
  const timeStartRef = useRef(Date.now());
  const timeThresholdsRef = useRef<Set<number>>(new Set());
  const exitFiredRef = useRef(false);
  const errorCountRef = useRef(0);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastPathRef = useRef(window.location.pathname);

  useEffect(() => {
    if (isLocal()) return;

    const originalPushState = history.pushState.bind(history);
    const originalReplaceState = history.replaceState.bind(history);

    /** Reset per-route trackers */
    const resetRouteTrackers = () => {
      scrollDepthsRef.current.clear();
      timeStartRef.current = Date.now();
      timeThresholdsRef.current.clear();
      exitFiredRef.current = false;
    };

    /** Observe sections with data-section-id after DOM settles */
    const observeSections = () => {
      if (observerRef.current) observerRef.current.disconnect();

      const seen = new Set<string | undefined>();
      observerRef.current = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const id = entry.target instanceof HTMLElement ? entry.target.dataset.sectionId : undefined;
          if (entry.isIntersecting && !seen.has(id)) {
            seen.add(id);
            trackEvent('section-viewed', { section: id, page: window.location.pathname });
            observerRef.current?.unobserve(entry.target);
          }
        }
      }, { threshold: 0.3 });

      document.querySelectorAll('[data-section-id]').forEach((el) => {
        observerRef.current?.observe(el);
      });
    };

    /** Handle route change (pushState, replaceState, popstate) */
    const handleRouteChange = () => {
      const newPath = window.location.pathname;
      if (newPath === lastPathRef.current) return;
      lastPathRef.current = newPath;

      resetRouteTrackers();
      trackPageView();
      trackEvent('page-viewed', { page: newPath });
      setTimeout(observeSections, 100);
    };

    // Intercept pushState and replaceState
    history.pushState = (...args) => {
      originalPushState(...args);
      handleRouteChange();
    };
    history.replaceState = (...args) => {
      originalReplaceState(...args);
      handleRouteChange();
    };
    window.addEventListener('popstate', handleRouteChange);

    // --- Scroll depth ---
    const handleScroll = () => {
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      if (docHeight <= 0) return;
      const percent = Math.round((window.scrollY / docHeight) * 100);
      for (const depth of [25, 50, 75, 100]) {
        if (percent >= depth && !scrollDepthsRef.current.has(depth)) {
          scrollDepthsRef.current.add(depth);
          trackEvent('scroll-depth', { depth, page: window.location.pathname });
        }
      }
    };
    window.addEventListener('scroll', handleScroll, { passive: true });

    // --- Time on page ---
    intervalRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - timeStartRef.current) / 1000);
      for (const threshold of [30, 60, 120, 300]) {
        if (elapsed >= threshold && !timeThresholdsRef.current.has(threshold)) {
          timeThresholdsRef.current.add(threshold);
          trackEvent('time-on-page', { seconds: threshold, page: window.location.pathname });
        }
      }
    }, 5000);

    // --- Exit intent ---
    const handleMouseout = (e: MouseEvent) => {
      if (!e.relatedTarget && !exitFiredRef.current && e.clientY < 10) {
        exitFiredRef.current = true;
        trackEvent('exit-intent', { page: window.location.pathname });
      }
    };
    document.addEventListener('mouseout', handleMouseout);

    // --- Page load performance (once) ---
    const navEntry = performance.getEntriesByType('navigation')[0];
    const perf = navEntry instanceof PerformanceNavigationTiming ? navEntry : undefined;
    if (perf) {
      const loadTime = Math.round(perf.loadEventEnd - perf.startTime);
      const speed = loadTime < 1000 ? 'fast' : loadTime < 3000 ? 'medium' : 'slow';
      trackEvent('page-load', { ms: loadTime, speed });
    }

    // --- JS error tracking (max 5 per session) ---
    const handleError = (e: ErrorEvent) => {
      if (errorCountRef.current >= 5) return;
      errorCountRef.current++;
      trackEvent('js-error', { message: (e.message || 'unknown').substring(0, 50), page: window.location.pathname });
    };
    window.addEventListener('error', handleError);

    // --- Text copy ---
    const handleCopy = () => {
      trackEvent('text-copied', { page: window.location.pathname });
    };
    document.addEventListener('copy', handleCopy);

    // Initial section observation
    setTimeout(observeSections, 100);

    // Fire initial page view
    trackEvent('page-viewed', { page: window.location.pathname });

    return () => {
      history.pushState = originalPushState;
      history.replaceState = originalReplaceState;
      window.removeEventListener('popstate', handleRouteChange);
      window.removeEventListener('scroll', handleScroll);
      document.removeEventListener('mouseout', handleMouseout);
      window.removeEventListener('error', handleError);
      document.removeEventListener('copy', handleCopy);
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (observerRef.current) observerRef.current.disconnect();
    };
  }, []);
}
