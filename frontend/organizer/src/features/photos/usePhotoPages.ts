import { useCallback, useEffect, useRef, useState } from "react";
import { photoError, type PhotoPage } from "./photoApi";

export function usePhotoPages<T extends PhotoPage>(
  load: (after?: string, signal?: AbortSignal) => Promise<T>,
  refreshInterval?: number,
) {
  const [page, setPage] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [request, setRequest] = useState<{ after?: string; refresh?: boolean }>({});
  const loadedPages = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    async function loadRequest() {
      let result = await load(request.after, controller.signal);
      let count = 1;
      while (request.refresh && result.next && count < loadedPages.current && !controller.signal.aborted) {
        const next = await load(result.next, controller.signal);
        result = { ...result, next: next.next, items: [...result.items, ...next.items] };
        count++;
      }
      if (controller.signal.aborted) return;
      loadedPages.current = request.after ? loadedPages.current + 1 : count;
      setPage(current => request.after && current ? { ...current, next: result.next, items: [...current.items, ...result.items] } : result);
    }
    loadRequest().catch(error => {
      if (!controller.signal.aborted && !request.refresh) setError(photoError(error));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [load, request]);

  useEffect(() => {
    if (!refreshInterval || loading || !page) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        setLoading(true);
        setRequest({ refresh: true });
      }
    }, refreshInterval);
    return () => window.clearInterval(timer);
  }, [refreshInterval, loading, page]);

  const fetchPage = useCallback((after?: string) => {
    setError("");
    setLoading(true);
    setRequest({ after });
  }, []);
  return { page, loading, error, fetchPage };
}
