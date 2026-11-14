// The 5 vendor routes (docs/api/vendors.md), in the shared RouteDef shape.
// Paths must match the API Gateway resource paths exactly.
// Each route checks event membership before doing anything else.
import { requireMember } from "../../shared/auth/requireMember";
import { idParam, type RouteDef } from "../../shared/http/routes";
import * as vendors from "../services/vendorService";

const LIST = "/events/{eventId}/vendors";
const ONE = "/events/{eventId}/vendors/{vendorId}";

export const vendorRoutes: RouteDef[] = [
  {
    method: "GET",
    path: LIST,
    async handle({ params, sub }) {
      const eventId = await requireMember(idParam(params.eventId), sub);
      return { status: 200, body: await vendors.listVendors(eventId) };
    },
  },
  {
    method: "GET",
    path: ONE,
    async handle({ params, sub }) {
      const eventId = await requireMember(idParam(params.eventId), sub);
      return {
        status: 200,
        body: await vendors.getVendor(eventId, idParam(params.vendorId)),
      };
    },
  },
  {
    method: "POST",
    path: LIST,
    async handle({ params, sub, body }) {
      const eventId = await requireMember(idParam(params.eventId), sub);
      return { status: 201, body: await vendors.createVendor(eventId, body) };
    },
  },
  {
    method: "PATCH",
    path: ONE,
    async handle({ params, sub, body }) {
      const eventId = await requireMember(idParam(params.eventId), sub);
      return {
        status: 200,
        body: await vendors.updateVendor(
          eventId,
          idParam(params.vendorId),
          body,
        ),
      };
    },
  },
  {
    method: "DELETE",
    path: ONE,
    async handle({ params, sub }) {
      const eventId = await requireMember(idParam(params.eventId), sub);
      await vendors.deleteVendor(eventId, idParam(params.vendorId));
      return { status: 204 };
    },
  },
];
