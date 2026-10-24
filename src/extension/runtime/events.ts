import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { PiRuntimeOutput } from "../provider/output.ts";
import { CliEventTranslator, type ConversationErrorState } from "../drivers/cli/events.ts";
import type { AgyEvent } from "../shared/types.ts";
import { debugLog } from "../shared/debug.ts";

export type { ConversationErrorState } from "../drivers/cli/events.ts";

export interface AgyEventAdapterOptions {
  errorState?: ConversationErrorState | undefined;
  model: string;
  provider?: string;
  stream?: AssistantMessageEventStream;
  allowedToolNames?: ReadonlySet<string>;
  bridgeToolCallsExternally?: boolean;
  onBlockedTool?: (name: string) => void;
}

export class PiEventAdapter extends PiRuntimeOutput {
  private readonly translator: CliEventTranslator;

  constructor(options: AgyEventAdapterOptions) {
    super({ ...options, allowLegacyNativeToolCalls: !options.bridgeToolCallsExternally });
    this.translator = new CliEventTranslator(options);
  }

  public setErrorState(state: ConversationErrorState): void {
    this.translator.setErrorState(state);
  }

  public override handleTermination(reason: "error" | "aborted", errorMessage?: string): void {
    super.handleTermination(reason, errorMessage || undefined);
  }

  public getBlockedToolName(event: AgyEvent): string | undefined {
    return this.translator.getBlockedToolName(event);
  }

  public handleEvent(event: AgyEvent, source: "agy" | "runtime" = "agy"): void {
    if (this.isCompleted()) {
      debugLog("events", `Ignoring event after stream completed: ${event.event}`);
      return;
    }

    this.translator.translate(event, source, (fact) => this.handleRuntimeEvent(fact));
  }
}

export { PiEventAdapter as AgyEventAdapter };
