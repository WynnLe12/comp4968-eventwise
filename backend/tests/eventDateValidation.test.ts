import "./testEnvironment";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createAppServer } from "../server";
import { EventService, EventValidationError, validateEventInput, validateEventPatch } from "../event-service/services/eventService";
import type { EventWithMembership } from "../event-service/repositories/eventRepository";
import { localToday, validDate } from "../shared/utils/dateOnly";
import { validDate as expenseDate } from "../expense-service/services/validation";

const today = "2028-03-01";
const record: EventWithMembership = { event_id: "1", name: "Event", event_date: "2028-02-29", template_id: null,
  venue: null, total_budget: "0.00", role: "OWNER", created_at: new Date(), updated_at: new Date() };

test("event dates reject yesterday/impossible dates and accept today/future dates", () => {
  for (const validate of [validateEventInput, validateEventPatch]) {
    assert.throws(() => validate({ name: "Event", event_date: "2028-02-29" }, today), /Event date cannot be in the past\./);
    for (const date of [today, "2028-03-02"]) assert.equal(validate({ name: "Event", event_date: date }, today).event_date, date);
    for (const date of ["", "2028-02-30", "2027-02-29", "2028-03-01T00:00:00Z"]) {
      assert.throws(() => validate({ name: "Event", event_date: date }, today), /Enter a valid event date\./);
    }
  }
  assert.throws(() => validateEventInput({ name: " " }, today), EventValidationError);
  assert.equal(validateEventInput({ name: "Event" }, today).event_date, null); // Preserve API defaults/nullable contract.
  assert.deepEqual(validateEventPatch({ event_date: null }, today), { event_date: null });
});

test("shared calendar validation preserves Expense's behavior, including past due dates", () => {
  assert.equal(localToday(new Date(2028, 1, 29, 23, 59)), "2028-02-29");
  assert.equal(expenseDate, validDate);
  assert.equal(expenseDate("2020-01-01"), true);
  assert.equal(expenseDate("2028-02-30"), false);
});

test("PATCH cannot retain a saved past date by updating another field", async () => {
  let writes = 0;
  const service = new EventService({
    create: async () => { throw new Error("not used"); },
    update: async (_id, patch, _sub, authorize) => { authorize(record); writes++; return { ...record, ...patch }; },
  }, () => today);
  for (const body of [{ name: "Changed" }, { event_date: "2028-02-29" }]) await assert.rejects(service.update("1", body, "owner"), EventValidationError);
  assert.equal(writes, 0);
  assert.equal((await service.update("1", { event_date: today }, "owner")).event_date, today);
  assert.equal(writes, 1);
});

test("authenticated HTTP create/update date errors retain the existing response format", async () => {
  let writes = 0;
  const service = new EventService({
    create: async (input) => { writes++; return { ...record, ...input }; },
    update: async (_id, patch, _sub, authorize) => { authorize(record); writes++; return { ...record, ...patch }; },
  }, () => today);
  const dependencies = { service, verifyToken: async () => "owner" };
  const server = createAppServer(dependencies, {}, {}, dependencies);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`;
    for (const method of ["POST", "PATCH"]) {
      const request = (date: string) => fetch(method === "POST" ? url : `${url}/1`, {
        method, headers: { authorization: "Bearer token", "content-type": "application/json" }, body: JSON.stringify({ name: "Event", event_date: date }),
      });
      const rejected = await request("2028-02-29");
      assert.equal(rejected.status, 400);
      assert.deepEqual(await rejected.json(), { error: "Event date cannot be in the past." });
      for (const date of [today, "2028-03-02"]) assert.equal((await request(date)).status, method === "POST" ? 201 : 200);
    }
    assert.equal(writes, 4);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
