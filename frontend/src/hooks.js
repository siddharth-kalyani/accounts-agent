import { useEffect, useRef } from "react";

// True while the component is on screen. It must be set on mount, not only
// cleared on unmount: React StrictMode (development) mounts, unmounts and
// mounts again, and a ref that is only cleared would stay false and drop
// every response that arrives afterwards.
export function useMounted() {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}
