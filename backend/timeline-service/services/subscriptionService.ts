// Organizer opt-in for timeline emails (Feature 13, US42-43). Rules: docs/api/timeline.md §4.
//
// event_members has no email column and the VPC Lambda cannot reach Cognito, so the browser
// sends the user's ID token once; its verified email is stored with the subscription.
// Subscribers are re-checked against event_members before every send (notification commit),
// so a removed co-planner stops getting emails even if their row remains.

import { requireMember as requireMemberInMySql } from "../../shared/auth/requireMember";
import type { TimelineRepository } from "../repositories/timelineRepository";
import type { Subscription } from "../types";
import type { VerifyIdTokenEmail } from "./idTokenEmail";
import type { MembershipCheck } from "./timelineService";
import { requireEventId, validateSubscriptionBody } from "./validation";

export type SubscriberStore = Pick<TimelineRepository, "getSubscriber" | "putSubscriber" | "deleteSubscriber">;

export interface SubscriptionServiceOptions {
  repository: SubscriberStore;
  verifyIdTokenEmail: VerifyIdTokenEmail;
  requireMember?: MembershipCheck;
}

export class SubscriptionService {
  private readonly repository: SubscriberStore;
  private readonly verifyIdTokenEmail: VerifyIdTokenEmail;
  private readonly requireMember: MembershipCheck;

  constructor(options: SubscriptionServiceOptions) {
    this.repository = options.repository;
    this.verifyIdTokenEmail = options.verifyIdTokenEmail;
    this.requireMember = options.requireMember ?? requireMemberInMySql;
  }

  async get(rawEventId: unknown, sub: string): Promise<Subscription> {
    const eventId = requireEventId(rawEventId);
    await this.requireMember(eventId, sub);
    const record = await this.repository.getSubscriber(eventId, sub);
    return { subscribed: Boolean(record), email: record?.email ?? null };
  }

  async subscribe(rawEventId: unknown, sub: string, body: unknown): Promise<Subscription> {
    const eventId = requireEventId(rawEventId);
    await this.requireMember(eventId, sub);
    const { idToken } = validateSubscriptionBody(body);
    const email = await this.verifyIdTokenEmail(idToken, sub);
    const record = await this.repository.putSubscriber(eventId, sub, email);
    return { subscribed: true, email: record.email };
  }

  async unsubscribe(rawEventId: unknown, sub: string): Promise<void> {
    const eventId = requireEventId(rawEventId);
    await this.requireMember(eventId, sub);
    await this.repository.deleteSubscriber(eventId, sub);
  }
}
