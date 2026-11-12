/**
 * Simulated network layer used while services run on in-memory mock data.
 *
 * To preview failure and empty states without a backend, set a scenario in the
 * browser console, then navigate away from the page and back (a full reload also
 * signs you out of the wireframe):
 *
 *   localStorage.setItem("eventwise.mock", "error")      // list requests fail (clear it, then Retry)
 *   localStorage.setItem("eventwise.mock", "forbidden")  // 403, no access to the event
 *   localStorage.setItem("eventwise.mock", "empty")      // event has no records
 *   localStorage.setItem("eventwise.mock", "save-error") // create/update fail unexpectedly
 *   localStorage.setItem("eventwise.mock", "slow")       // 1.5s latency
 *   localStorage.removeItem("eventwise.mock")            // back to normal
 */
export type MockScenario = "error" | "forbidden" | "empty" | "save-error" | "slow";

export function mockScenario(): MockScenario | null {
  try {
    return (window.localStorage.getItem("eventwise.mock") as MockScenario | null) ?? null;
  } catch {
    return null;
  }
}

/**
 * Waits like a network round trip, then runs `work`. Anything `work` throws is
 * rejected the same way an API error would be. The result is cloned so callers
 * can never mutate the mock store directly.
 */
export async function mockRequest<T>(work: () => T, delay = 250): Promise<T> {
  const latency = mockScenario() === "slow" ? 1500 : delay;
  await new Promise((resolve) => window.setTimeout(resolve, latency));
  return structuredClone(work());
}
