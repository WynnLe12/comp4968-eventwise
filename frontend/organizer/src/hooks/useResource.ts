import { useCallback, useEffect, useState } from "react";

interface ResourceSnapshot<T> {
  data: T | null;
  loading: boolean;
  error: unknown;
}

export interface ResourceState<T> extends ResourceSnapshot<T> {
  /** Runs the loader again (shows the loading state). Use for retries. */
  reload: () => void;
  /** Updates loaded data in place after a successful mutation, without refetching. */
  update: (change: (current: T) => T) => void;
}

/** Loads async data and tracks loading/error state. Pass a stable (memoized) loader. */
export function useResource<T>(loader: () => Promise<T>): ResourceState<T> {
  const [state, setState] = useState<ResourceSnapshot<T>>({
    data: null,
    loading: true,
    error: null,
  });
  const [request, setRequest] = useState(0);

  useEffect(() => {
    let active = true;
    setState((current) => ({ ...current, loading: true, error: null }));
    loader()
      .then((data) => {
        if (active) setState({ data, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (active) setState({ data: null, loading: false, error });
      });
    return () => {
      active = false;
    };
  }, [loader, request]);

  const reload = useCallback(() => setRequest((value) => value + 1), []);
  const update = useCallback(
    (change: (current: T) => T) =>
      setState((current) =>
        current.data === null ? current : { ...current, data: change(current.data) },
      ),
    [],
  );

  return { ...state, reload, update };
}
