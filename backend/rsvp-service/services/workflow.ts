// Starts and stops the RSVP deadline workflow (AWS Step Functions, Feature 8).
// Definition: infrastructure/stepfunctions/rsvp-deadline.asl.json.
//
// One execution per "send invitations": wait until the reminder time → remind guests who
// haven't answered (once) → wait until the deadline → close RSVPs. Re-sending invitations
// starts a new execution with a new workflowId and stops the old one. The deadline Lambda
// also ignores any run whose workflowId is no longer current, so correctness never depends
// on the stop succeeding.

import { SFNClient, StartExecutionCommand, StopExecutionCommand } from "@aws-sdk/client-sfn";
import { RsvpConfigurationError } from "../rsvpLink";

/** The state machine's input. Instants are "YYYY-MM-DDTHH:MM:SSZ", as Wait TimestampPath requires. */
export interface WorkflowInput {
  eventId: string;
  workflowId: string;
  reminderAt: string | null;
  deadline: string;
}

export interface Workflow {
  start(input: WorkflowInput): Promise<string>;
  /** Best effort: a failure is logged, never thrown. */
  stop(executionArn: string): Promise<void>;
}

export function createStepFunctionsWorkflow(
  stateMachineArn: string | undefined,
  client: Pick<SFNClient, "send"> = new SFNClient({ maxAttempts: 2 }),
  log: (message: string) => void = (message) => console.error(message),
): Workflow {
  return {
    async start(input) {
      if (!stateMachineArn?.startsWith("arn:")) {
        throw new RsvpConfigurationError("RSVP_STATE_MACHINE_ARN must be the deadline workflow's ARN");
      }
      const result = await client.send(new StartExecutionCommand({
        stateMachineArn,
        // Names are unique per state machine for 90 days; the workflowId is a fresh UUID.
        name: `rsvp-${input.eventId}-${input.workflowId}`,
        input: JSON.stringify(input),
      }), { abortSignal: AbortSignal.timeout(5_000) });
      if (!result.executionArn) throw new Error("Step Functions returned no execution ARN");
      return result.executionArn;
    },
    async stop(executionArn) {
      try {
        await client.send(new StopExecutionCommand({
          executionArn,
          cause: "Invitations were sent again with new RSVP settings.",
        }), { abortSignal: AbortSignal.timeout(5_000) });
      } catch (error) {
        // Already finished, or no permission: the stale run will see a new workflowId and do nothing.
        log(`Stopping an earlier RSVP workflow failed: ${error instanceof Error ? error.name : "unknown error"}`);
      }
    },
  };
}
